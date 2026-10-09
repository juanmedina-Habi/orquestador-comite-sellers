/**
 * Una lectura de BigQuery al día. El resultado se comprime y se guarda en Drive.
 * Abrir el tablero y mover filtros no vuelve a consultar: el navegador usa ese archivo.
 * Quien publica el tablero corre setup() una vez desde el editor.
 */

var CARPETA_SNAPSHOTS = 'Orquestador Comité Sellers — snapshots';
var TOPE_GZIP = 20 * 1024 * 1024;

function setup() {
  var props = PropertiesService.getScriptProperties();
  var email = emailUsuario_() || Session.getEffectiveUser().getEmail();
  if (email) props.setProperty('OWNER_EMAIL', email);
  asegurarCarpeta_();
  instalarTrigger_();
  return refreshSnapshots();
}

function instalarTrigger_() {
  var hayDiario = false;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshSnapshots') hayDiario = true;
  });
  if (hayDiario) return;
  ScriptApp.newTrigger('refreshSnapshots')
    .timeBased()
    .atHour(7)
    .everyDays(1)
    .inTimezone('America/Bogota')
    .create();
}

function prepararDia() {
  return programarLectura_(false);
}

function pedirActualizacion() {
  return programarLectura_(true);
}

function adminRefresh() {
  return programarLectura_(true);
}

function programarLectura_(forzar) {
  assertAllowed_();
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('OWNER_EMAIL')) {
    var email = emailUsuario_();
    if (email) props.setProperty('OWNER_EMAIL', email);
  }
  if (!isOwner_()) return estadoPublico_();
  try { instalarTrigger_(); } catch (e) {}
  if (snapshotListo_() && !forzar) return estadoPublico_();
  if (refreshEnCurso_()) return estadoPublico_();
  try {
    programarUnaVez_();
  } catch (e2) {
    return {
      error: 'No se pudo dejar la lectura en segundo plano. Vuelve a abrir el tablero y acepta los permisos, o ejecuta setup() en el editor.',
    };
  }
  props.setProperty('SNAP_ESTADO', 'programado');
  props.setProperty('SNAP_DESDE', String(Date.now()));
  props.deleteProperty('SNAP_ERROR');
  return estadoPublico_();
}

function programarUnaVez_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'refreshUnaVez') return;
  }
  ScriptApp.newTrigger('refreshUnaVez').timeBased().after(60 * 1000).create();
}

function refreshUnaVez() {
  try {
    refreshSnapshots();
  } finally {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'refreshUnaVez') ScriptApp.deleteTrigger(t);
    });
  }
}

function refreshSnapshots() {
  if (!puedeRefrescar_()) throw new Error('Solo quien publica el tablero puede leer BigQuery.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return estadoPublico_();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SNAP_ESTADO', 'corriendo');
  props.setProperty('SNAP_DESDE', String(Date.now()));
  props.deleteProperty('SNAP_ERROR');
  var actualizado = selloBogota();
  var specs = especificaciones_();
  var pendientes = [];
  var fallo = {};
  specs.forEach(function (spec) {
    try {
      spec.ref = lanzarConsulta_(spec.sql);
      pendientes.push(spec);
    } catch (e) {
      fallo[spec.nombre] = e.message;
    }
  });
  var inicio = Date.now();
  while (pendientes.length && Date.now() - inicio < 15 * 60 * 1000) {
    var siguen = [];
    pendientes.forEach(function (spec) {
      try {
        if (!jobListo_(spec.ref)) siguen.push(spec);
      } catch (e) {
        fallo[spec.nombre] = e.message;
      }
    });
    pendientes = siguen;
    if (pendientes.length) Utilities.sleep(1500);
  }
  pendientes.forEach(function (spec) {
    if (!fallo[spec.nombre]) fallo[spec.nombre] = 'BigQuery no terminó a tiempo';
  });
  var tablas = leerMeta_().tablas || {};
  var errores = [];
  specs.forEach(function (spec) {
    if (fallo[spec.nombre]) {
      errores.push(spec.nombre + ': ' + fallo[spec.nombre]);
      tablas[spec.nombre] = Object.assign({}, tablas[spec.nombre], { error: fallo[spec.nombre] });
      return;
    }
    try {
      var viejo = tablas[spec.nombre] && tablas[spec.nombre].fileId;
      var info = guardarTabla_(spec);
      tablas[spec.nombre] = info;
      publicarMeta_(actualizado, tablas, errores);
      if (viejo && viejo !== info.fileId) {
        try { DriveApp.getFileById(viejo).setTrashed(true); } catch (e2) {}
      }
    } catch (e) {
      errores.push(spec.nombre + ': ' + e.message);
      tablas[spec.nombre] = Object.assign({}, tablas[spec.nombre], { error: e.message });
    }
  });
  publicarMeta_(actualizado, tablas, errores);
  if (errores.length) {
    props.setProperty('SNAP_ESTADO', 'error');
    props.setProperty('SNAP_ERROR', errores.join(' | '));
    lock.releaseLock();
    throw new Error(errores.join(' | '));
  }
  props.setProperty('SNAP_ESTADO', 'listo');
  props.deleteProperty('SNAP_ERROR');
  lock.releaseLock();
  return resumenMeta_(leerMeta_());
}

function publicarMeta_(actualizado, tablas, errores) {
  PropertiesService.getScriptProperties().setProperty('SNAP_META', JSON.stringify({
    actualizado: actualizado,
    ok: !errores.length,
    tablas: tablas,
    errores: errores,
  }));
}

function snapshotListo_() {
  var meta = leerMeta_();
  return !!(meta.tablas && meta.tablas.sla && meta.tablas.sla.fileId
    && meta.tablas.micro && meta.tablas.micro.fileId
    && meta.tablas.inmo && meta.tablas.inmo.fileId);
}

function refreshEnCurso_() {
  var props = PropertiesService.getScriptProperties();
  var estado = props.getProperty('SNAP_ESTADO') || '';
  if (estado !== 'corriendo' && estado !== 'programado') return false;
  var desde = Number(props.getProperty('SNAP_DESDE') || '0');
  var tope = estado === 'programado' ? 5 * 60 * 1000 : 40 * 60 * 1000;
  return Date.now() - desde < tope;
}

function estadoPublico_() {
  var meta = leerMeta_();
  var props = PropertiesService.getScriptProperties();
  return {
    owner: isOwner_(),
    actualizado: meta.actualizado || '',
    listo: snapshotListo_(),
    corriendo: refreshEnCurso_(),
    hora: '7:00',
    funnel: funnelListo_(),
    errorRefresh: props.getProperty('SNAP_ERROR') || '',
    errores: meta.errores || [],
  };
}

function getBootstrap() {
  if (!usuarioPermitido_()) return { error: 'Sin acceso' };
  var estado = estadoPublico_();
  var meta = leerMeta_();
  var filas = {};
  ['sla', 'micro', 'inmo'].forEach(function (nombre) {
    filas[nombre] = ((meta.tablas && meta.tablas[nombre]) || {}).filas || 0;
  });
  estado.filas = filas;
  return estado;
}

function getSnapshot(nombre) {
  if (!usuarioPermitido_()) return { error: 'Sin acceso' };
  if (['sla', 'micro', 'inmo', 'funnel'].indexOf(nombre) < 0) return { error: 'Tabla desconocida' };
  var meta = leerMeta_();
  var info = (meta.tablas && meta.tablas[nombre]) || {};
  if (!info.fileId) return { error: 'Todavía no está el archivo del día.' };
  var b64 = leerCacheSnap_(nombre, meta.actualizado);
  if (!b64) {
    var archivo = DriveApp.getFileById(info.fileId);
    b64 = Utilities.base64Encode(archivo.getBlob().getBytes());
    guardarCacheSnap_(nombre, meta.actualizado, b64);
  }
  return { b64: b64, filas: info.filas || 0, actualizado: meta.actualizado || '' };
}

function crearHoja(paquete) {
  if (!usuarioPermitido_()) return { error: 'Sin acceso' };
  paquete = paquete || {};
  var encabezado = paquete.encabezado || [];
  var cuerpo = paquete.cuerpo || [];
  if (!encabezado.length || !cuerpo.length) return { error: 'No hay nid con estos filtros.' };
  if (cuerpo.length > TOPE_CSV) {
    return { error: 'Hay ' + miles(cuerpo.length) + ' nid en este recorte. Acota un filtro: la descarga llega hasta ' + miles(TOPE_CSV) + '.' };
  }
  var nombre = paquete.nombre || 'Orquestador';
  var ss = SpreadsheetApp.create(nombre);
  var hoja = ss.getSheets()[0];
  hoja.setName('Detalle');
  var filas = [encabezado].concat(cuerpo);
  var ancho = encabezado.length;
  var i = 0;
  while (i < filas.length) {
    var corte = filas.slice(i, i + 500);
    hoja.getRange(i + 1, 1, corte.length, ancho).setValues(normalizarCeldas_(corte, ancho));
    i += corte.length;
  }
  hoja.setFrozenRows(1);
  hoja.getRange(1, 1, 1, ancho).setFontWeight('bold');
  try {
    DriveApp.getFileById(ss.getId()).setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {}
  return { url: ss.getUrl(), nombre: nombre };
}

function normalizarCeldas_(filas, ancho) {
  return filas.map(function (fila) {
    var salida = [];
    for (var c = 0; c < ancho; c++) {
      var v = fila[c];
      salida.push(v == null ? '' : v);
    }
    return salida;
  });
}

function especificaciones_() {
  return [
    { nombre: 'sla', sql: sqlSla_(), string: ['nid', 'pais', 'propietario', 'equipo', 'dueno', 'respuesta', 'reintentos', 'etapa'], fecha: ['envio', 'fin'], numero: ['horas'] },
    { nombre: 'micro', sql: sqlMicro_(), string: ['vista', 'nid', 'pais', 'comite', 'agente', 'propietario', 'estado', 'tipo'], fecha: ['envio', 'inicio', 'fin'], numero: ['horas'] },
    { nombre: 'inmo', sql: sqlInmo_(), string: ['nid', 'pais', 'etapa', 'automatizacion'], fecha: ['envio', 'fin'], numero: ['horas'] },
    { nombre: 'funnel', version: 4, sql: sqlFunnel_(), string: ['nid', 'pais', 'equipo', 'propietario', 'dueno', 'estado', 'etapa', 'entro', 'inc_doc', 'inc_checks', 'inc_pricing', 'inc_hesh', 'inc_aprob', 'hora_envio', 'hora_doc', 'hora_remo', 'hora_checks', 'hora_pricing', 'hora_hesh', 'hora_aprob', 'hora_fin'], fecha: ['envio', 'fecha_doc', 'fecha_remo', 'fecha_checks', 'fecha_pricing', 'fecha_hesh', 'fecha_aprob', 'fin', 'fecha_respuesta'], numero: BITS_FUNNEL },
  ];
}

var BITS_FUNNEL = [
  'orq', 'rev_doc', 'doc_ok', 'doc_curso', 'doc_recha',
  'rev_checks', 'checks_ok', 'checks_curso',
  'rev_pricing', 'pricing_ok', 'pricing_curso', 'pricing_recha',
  'rev_remo', 'remo_ok', 'remo_curso', 'remo_recha',
  'rev_hesh', 'hesh_ok', 'hesh_curso',
  'rev_armado', 'armado_ok', 'armado_curso', 'armado_recha',
  'rev_aprob', 'aprob_ok', 'aprob_curso', 'aprob_recha',
  'comite_curso', 'envio_pasado',
];

function sqlSla_() {
  return [
    'SELECT',
    '  CAST(nid AS STRING) AS nid,',
    '  IFNULL(pais_hubspot, "") AS pais,',
    '  FORMAT_DATE("%F", DATE(fecha_envio_seller)) AS envio,',
    '  FORMAT_DATE("%F", DATE(fecha_respuesta_orquestador)) AS fin,',
    '  horas_habiles AS horas,',
    '  IFNULL(propietario_de_aprobacion_final, "") AS propietario,',
    '  IFNULL(equipo_sellers, "") AS equipo,',
    '  IFNULL(propietario_del_negocio, "") AS dueno,',
    '  CASE',
    '    WHEN LOWER(respuesta) = "inmueble aprobado" THEN "Aprobado"',
    '    WHEN LOWER(respuesta) IN ("descartado", "descartado comite", "descartado por comité") THEN "Descartado"',
    '    ELSE IFNULL(respuesta, "")',
    '  END AS respuesta,',
    '  CASE',
    '    WHEN reintentos = 0 THEN "No tuvo Reintentos"',
    '    WHEN reintentos IS NULL THEN ""',
    '    ELSE "Tuvo Reintentos"',
    '  END AS reintentos,',
    '  IFNULL(fase_rechazo, "") AS etapa',
    'FROM `papyrus-delivery-data.idm_tech.sla_orquestador`',
    'WHERE nid IS NOT NULL',
    '  AND fecha_respuesta_orquestador IS NOT NULL',
    '  AND DATE(fecha_respuesta_orquestador) <= CURRENT_DATE("America/Bogota")',
  ].join('\n');
}

function sqlMicro_() {
  return [
    'SELECT',
    '  CASE',
    '    WHEN tipo_tarea = "Revision de documentos" AND respuesta_doc_pais IS NOT NULL THEN "documentos"',
    '    WHEN tipo_tarea IN ("Pricing", "Pricing automático", "Pricing manual") AND flag_doc_avanza AND flag_checks_avanza THEN "pricing"',
    '    WHEN tipo_tarea = "Revision de Remodelación" AND flag_doc_avanza THEN "remo"',
    '    WHEN tipo_tarea = "Aprobologia" AND flag_doc_avanza AND flag_remo_avanza AND flag_checks_avanza AND flag_pricing_avanza AND flag_hesh_avanza THEN "aprobologia"',
    '    ELSE NULL',
    '  END AS vista,',
    '  CAST(nid AS STRING) AS nid,',
    '  IFNULL(pais, "") AS pais,',
    '  FORMAT_DATE("%F", DATE(fecha_envio_seller)) AS envio,',
    '  FORMAT_DATE("%F", DATE(fecha_inicio)) AS inicio,',
    '  FORMAT_DATE("%F", DATE(fecha_fin)) AS fin,',
    '  horas_habiles AS horas,',
    '  IF(IFNULL(ciclo_en_curso, 0) = 1, "Si", "No") AS comite,',
    '  IFNULL(owner, "") AS agente,',
    '  IFNULL(propietario_de_aprobacion_final, "") AS propietario,',
    '  IF(flag_aprobologia_avanza, "Aprobado", "Rechazado") AS estado,',
    '  IFNULL(tipo_tarea, "") AS tipo',
    'FROM `papyrus-delivery-data.idm_tech.micro_sla_orquestador`',
    'WHERE nid IS NOT NULL',
    '  AND fecha_fin IS NOT NULL',
    '  AND DATE(fecha_fin) <= CURRENT_DATE("America/Bogota")',
    '  AND (',
    '    (tipo_tarea = "Revision de documentos" AND respuesta_doc_pais IS NOT NULL)',
    '    OR (tipo_tarea IN ("Pricing", "Pricing automático", "Pricing manual") AND flag_doc_avanza AND flag_checks_avanza)',
    '    OR (tipo_tarea = "Revision de Remodelación" AND flag_doc_avanza)',
    '    OR (tipo_tarea = "Aprobologia" AND flag_doc_avanza AND flag_remo_avanza AND flag_checks_avanza AND flag_pricing_avanza AND flag_hesh_avanza)',
    '  )',
  ].join('\n');
}

function funnelListo_() {
  var meta = leerMeta_();
  var info = (meta.tablas && meta.tablas.funnel) || {};
  return !!(info.fileId && !info.error && Number(info.version) >= 4);
}

function prepararFunnel() {
  assertAllowed_();
  if (funnelListo_()) return { listo: true };
  if (!isOwner_()) return { listo: false };
  if (refreshEnCurso_()) return { listo: false, corriendo: true };
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'refreshFunnel') return { listo: false, corriendo: true };
  }
  try {
    ScriptApp.newTrigger('refreshFunnel').timeBased().after(60 * 1000).create();
  } catch (e) {
    return { error: 'No se pudo dejar la lectura del funnel en segundo plano.' };
  }
  return { listo: false, corriendo: true };
}

function refreshFunnel() {
  var lock = null;
  try {
    if (!puedeRefrescar_()) return;
    lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return;
    var spec = null;
    especificaciones_().forEach(function (s) { if (s.nombre === 'funnel') spec = s; });
    spec.ref = lanzarConsulta_(spec.sql);
    var inicio = Date.now();
    while (!jobListo_(spec.ref) && Date.now() - inicio < 10 * 60 * 1000) Utilities.sleep(1500);
    if (!jobListo_(spec.ref)) throw new Error('BigQuery no terminó a tiempo');
    var meta = leerMeta_();
    var tablas = meta.tablas || {};
    var viejo = tablas.funnel && tablas.funnel.fileId;
    var info = guardarTabla_(spec);
    tablas.funnel = info;
    publicarMeta_(selloBogota(), tablas, meta.errores || []);
    if (viejo && viejo !== info.fileId) {
      try { DriveApp.getFileById(viejo).setTrashed(true); } catch (e2) {}
    }
  } catch (e) {
    var metaError = leerMeta_();
    var tablasError = metaError.tablas || {};
    tablasError.funnel = Object.assign({}, tablasError.funnel, { error: e.message });
    publicarMeta_(metaError.actualizado || selloBogota(), tablasError, metaError.errores || []);
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e3) {} }
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'refreshFunnel') ScriptApp.deleteTrigger(t);
    });
  }
}

function bit_(expr) {
  return 'IF(' + expr + ', 1, 0)';
}

function sqlFunnel_() {
  var orq = 'IFNULL(flag_orquestador, FALSE)';
  var doc = orq + ' AND respuesta_doc_pais IS NOT NULL';
  var checks = orq + ' AND respuesta_checks_pais IS NOT NULL AND respuesta_doc_pais IS NOT NULL';
  var pricing = orq + ' AND respuesta_doc_pais IS NOT NULL AND IFNULL(flag_doc_avanza, FALSE) AND IFNULL(flag_checks_avanza, FALSE) AND (respuesta_pricing_pais IS NOT NULL OR IFNULL(flag_en_cola_pricing, FALSE))';
  var remo = orq + ' AND respuesta_remo_pais IS NOT NULL AND respuesta_doc_pais IS NOT NULL';
  var hesh = orq + ' AND respuesta_hesh_pais IS NOT NULL';
  var armado = orq + ' AND respuesta_ensamble_pais IS NOT NULL';
  var aprob = orq + ' AND respuesta_aprobologia_pais IS NOT NULL';
  return [
    'SELECT',
    '  CAST(nid AS STRING) AS nid,',
    '  IFNULL(pais_hubspot, "") AS pais,',
    '  FORMAT_DATE("%F", DATE(fecha_envio_seller)) AS envio,',
    '  FORMAT_DATE("%F", DATE(respuesta_doc_pais)) AS fecha_doc,',
    '  FORMAT_DATE("%F", DATE(respuesta_remo_pais)) AS fecha_remo,',
    '  FORMAT_DATE("%F", DATE(respuesta_checks_pais)) AS fecha_checks,',
    '  FORMAT_DATE("%F", DATE(respuesta_pricing_pais)) AS fecha_pricing,',
    '  FORMAT_DATE("%F", DATE(respuesta_hesh_pais)) AS fecha_hesh,',
    '  FORMAT_DATE("%F", DATE(respuesta_aprobologia_pais)) AS fecha_aprob,',
    '  FORMAT_DATE("%F", DATE(fin_comite_pais)) AS fin,',
    '  FORMAT_DATE("%F", DATE(fecha_respuesta)) AS fecha_respuesta,',
    '  IFNULL(FORMAT_DATETIME("%T", fecha_envio_seller), "") AS hora_envio,',
    '  IFNULL(FORMAT_DATETIME("%T", respuesta_doc_pais), "") AS hora_doc,',
    '  IFNULL(FORMAT_DATETIME("%T", respuesta_remo_pais), "") AS hora_remo,',
    '  IFNULL(FORMAT_DATETIME("%T", respuesta_checks_pais), "") AS hora_checks,',
    '  IFNULL(FORMAT_DATETIME("%T", respuesta_pricing_pais), "") AS hora_pricing,',
    '  IFNULL(FORMAT_DATETIME("%T", respuesta_hesh_pais), "") AS hora_hesh,',
    '  IFNULL(FORMAT_DATETIME("%T", respuesta_aprobologia_pais), "") AS hora_aprob,',
    '  IFNULL(FORMAT_DATETIME("%T", fin_comite_pais), "") AS hora_fin,',
    '  IFNULL(equipo_sellers, "") AS equipo,',
    '  IFNULL(estado_comite, "") AS estado,',
    '  CASE WHEN flag_orquestador IS NULL THEN "" WHEN flag_orquestador THEN "Si" ELSE "No" END AS entro,',
    '  CASE',
    '    WHEN NOT IFNULL(flag_orquestador, FALSE) THEN "No entró al orquestador"',
    '    WHEN respuesta_doc_pais IS NOT NULL AND IFNULL(flag_doc_estado_actual, FALSE) THEN "Revisión documentos"',
    '    WHEN respuesta_doc_pais IS NOT NULL AND IFNULL(flag_doc_avanza, FALSE) AND respuesta_remo_pais IS NOT NULL AND IFNULL(flag_remo_estado_actual, FALSE) THEN "Remo"',
    '    WHEN respuesta_doc_pais IS NOT NULL AND IFNULL(flag_doc_avanza, FALSE) AND respuesta_checks_pais IS NOT NULL AND IFNULL(flag_checks_estado_actual, FALSE) THEN "Checks"',
    '    WHEN respuesta_doc_pais IS NOT NULL AND IFNULL(flag_doc_avanza, FALSE) AND IFNULL(flag_checks_avanza, FALSE) AND (respuesta_pricing_pais IS NOT NULL OR IFNULL(flag_en_cola_pricing, FALSE)) AND IFNULL(flag_princing_estado_actual, FALSE) THEN "Pricing"',
    '    WHEN respuesta_doc_pais IS NOT NULL AND IFNULL(flag_doc_avanza, FALSE) AND respuesta_hesh_pais IS NOT NULL AND IFNULL(flag_pricing_avanza, FALSE) AND IFNULL(flag_remo_avanza, FALSE) AND IFNULL(flag_hesh_estado_actual, FALSE) THEN "Hesh"',
    '    WHEN IFNULL(flag_doc_avanza, FALSE) AND IFNULL(flag_remo_avanza, FALSE) AND respuesta_aprobologia_pais IS NOT NULL AND IFNULL(flag_pricing_avanza, FALSE) AND IFNULL(flag_hesh_avanza, FALSE) AND IFNULL(flag_aprobologia_estado_actual, FALSE) THEN "Aprobologia"',
    '    ELSE "Finalizado"',
    '  END AS etapa,',
    '  CASE',
    '    WHEN IFNULL(flag_orquestador, FALSE) AND respuesta_doc_pais IS NULL THEN "Si"',
    '    WHEN IFNULL(flag_orquestador, FALSE) THEN "No"',
    '    ELSE ""',
    '  END AS inc_doc,',
    '  CASE',
    '    WHEN IFNULL(flag_orquestador, FALSE) AND IFNULL(flag_doc_avanza, FALSE) AND NOT (respuesta_checks_pais IS NOT NULL AND respuesta_doc_pais IS NOT NULL) THEN "Si"',
    '    ELSE "No"',
    '  END AS inc_checks,',
    '  CASE',
    '    WHEN IFNULL(flag_orquestador, FALSE) AND IFNULL(flag_checks_avanza, FALSE) AND NOT (respuesta_doc_pais IS NOT NULL AND IFNULL(flag_doc_avanza, FALSE) AND IFNULL(flag_checks_avanza, FALSE) AND (respuesta_pricing_pais IS NOT NULL OR IFNULL(flag_en_cola_pricing, FALSE))) THEN "Si"',
    '    ELSE "No"',
    '  END AS inc_pricing,',
    '  CASE',
    '    WHEN IFNULL(flag_orquestador, FALSE) AND IFNULL(flag_doc_avanza, FALSE) AND IFNULL(flag_remo_avanza, FALSE) AND IFNULL(flag_pricing_avanza, FALSE) AND respuesta_hesh_pais IS NULL THEN "Si"',
    '    WHEN IFNULL(flag_orquestador, FALSE) AND IFNULL(flag_doc_avanza, FALSE) AND IFNULL(flag_remo_avanza, FALSE) AND IFNULL(flag_pricing_avanza, FALSE) THEN "No"',
    '    ELSE ""',
    '  END AS inc_hesh,',
    '  CASE',
    '    WHEN IFNULL(flag_orquestador, FALSE) AND IFNULL(flag_doc_avanza, FALSE) AND IFNULL(flag_remo_avanza, FALSE) AND IFNULL(flag_pricing_avanza, FALSE) AND IFNULL(flag_hesh_avanza, FALSE) AND respuesta_aprobologia_pais IS NULL THEN "Si"',
    '    WHEN IFNULL(flag_orquestador, FALSE) AND IFNULL(flag_doc_avanza, FALSE) AND IFNULL(flag_remo_avanza, FALSE) AND IFNULL(flag_pricing_avanza, FALSE) AND IFNULL(flag_hesh_avanza, FALSE) THEN "No"',
    '    ELSE ""',
    '  END AS inc_aprob,',
    '  IFNULL(propietario_de_aprobacion_final, "") AS propietario,',
    '  IFNULL(propietario_del_negocio, "") AS dueno,',
    '  ' + bit_(orq) + ' AS orq,',
    '  ' + bit_(doc) + ' AS rev_doc,',
    '  ' + bit_('IFNULL(flag_doc_avanza, FALSE)') + ' AS doc_ok,',
    '  ' + bit_('IFNULL(flag_doc_estado_actual, FALSE)') + ' AS doc_curso,',
    '  ' + bit_('IFNULL(flag_doc_recha, FALSE)') + ' AS doc_recha,',
    '  ' + bit_(checks) + ' AS rev_checks,',
    '  ' + bit_('IFNULL(flag_checks_avanza, FALSE)') + ' AS checks_ok,',
    '  ' + bit_('IFNULL(flag_checks_estado_actual, FALSE)') + ' AS checks_curso,',
    '  ' + bit_(pricing) + ' AS rev_pricing,',
    '  ' + bit_('IFNULL(flag_pricing_avanza, FALSE)') + ' AS pricing_ok,',
    '  ' + bit_('IFNULL(flag_princing_estado_actual, FALSE)') + ' AS pricing_curso,',
    '  ' + bit_('IFNULL(flag_pricing_recha, FALSE)') + ' AS pricing_recha,',
    '  ' + bit_(remo) + ' AS rev_remo,',
    '  ' + bit_('IFNULL(flag_remo_avanza, FALSE)') + ' AS remo_ok,',
    '  ' + bit_('IFNULL(flag_remo_estado_actual, FALSE)') + ' AS remo_curso,',
    '  ' + bit_('IFNULL(flag_remo_recha, FALSE)') + ' AS remo_recha,',
    '  ' + bit_(hesh) + ' AS rev_hesh,',
    '  ' + bit_('IFNULL(flag_hesh_avanza, FALSE)') + ' AS hesh_ok,',
    '  ' + bit_('IFNULL(flag_hesh_estado_actual, FALSE)') + ' AS hesh_curso,',
    '  ' + bit_(armado) + ' AS rev_armado,',
    '  ' + bit_('IFNULL(flag_ensamble_avanza, FALSE)') + ' AS armado_ok,',
    '  ' + bit_('IFNULL(flag_ensamble_estado_actual, FALSE)') + ' AS armado_curso,',
    '  ' + bit_('IFNULL(flag_ensamble_recha, FALSE)') + ' AS armado_recha,',
    '  ' + bit_(aprob) + ' AS rev_aprob,',
    '  ' + bit_('IFNULL(flag_aprobologia_avanza, FALSE)') + ' AS aprob_ok,',
    '  ' + bit_('IFNULL(flag_aprobologia_estado_actual, FALSE)') + ' AS aprob_curso,',
    '  ' + bit_('IFNULL(flag_aprobologia_recha, FALSE)') + ' AS aprob_recha,',
    '  ' + bit_('IFNULL(flag_comite_curso, FALSE)') + ' AS comite_curso,',
    '  ' + bit_('IFNULL(flag_envio_mes_pasado, FALSE)') + ' AS envio_pasado',
    'FROM `papyrus-delivery-data.idm_tech.tabla_funnel_orquestador`',
    'WHERE nid IS NOT NULL',
    '  AND (fecha_envio_seller IS NULL OR DATE(fecha_envio_seller) <= CURRENT_DATE("America/Bogota"))',
  ].join('\n');
}

function sqlInmo_() {
  return [
    'SELECT',
    '  CAST(nid AS STRING) AS nid,',
    '  IFNULL(pais_hubspot, "") AS pais,',
    '  FORMAT_DATE("%F", DATE(fecha_envio_seller)) AS envio,',
    '  FORMAT_DATE("%F", DATE(fin_general)) AS fin,',
    '  horas_habiles AS horas,',
    '  CASE etapa',
    '    WHEN "COMPLETED" THEN "Aprobado"',
    '    WHEN "IN_PROGRESS" THEN "En proceso"',
    '    WHEN "REJECTED" THEN "Rechazado"',
    '    ELSE IFNULL(etapa, "")',
    '  END AS etapa,',
    '  IFNULL(automatizacion, "") AS automatizacion',
    'FROM `papyrus-delivery-data.idm_tech.funnel_orquestador_inmo`',
    'WHERE nid IS NOT NULL',
    '  AND fin_general IS NOT NULL',
    '  AND DATE(fin_general) <= CURRENT_DATE("America/Bogota")',
  ].join('\n');
}

function lanzarConsulta_(sql) {
  var job = BigQuery.Jobs.insert({
    configuration: {
      query: { query: sql, useLegacySql: false, priority: 'INTERACTIVE' },
    },
  }, PROYECTO);
  return job.jobReference;
}

function jobListo_(ref) {
  var job = BigQuery.Jobs.get(ref.projectId, ref.jobId, { location: ref.location });
  var estado = job.status || {};
  if (estado.state !== 'DONE') return false;
  if (estado.errorResult) throw new Error(estado.errorResult.message);
  return true;
}

function guardarTabla_(spec) {
  var encoder = new Encoder_(spec);
  cadaFila_(spec.ref, function (fila) { encoder.push(fila); });
  var json = encoder.json();
  var bytes = Utilities.gzip(Utilities.newBlob(json, 'application/json', spec.nombre + '.json')).getBytes();
  if (bytes.length > TOPE_GZIP) throw new Error('El archivo pesa más de 20 MB. Hay que partir la tabla.');
  var archivo = asegurarCarpeta_().createFile(Utilities.newBlob(bytes, 'application/gzip', spec.nombre + '.json.gz'));
  return { filas: encoder.n, bytes: bytes.length, fileId: archivo.getId(), version: spec.version || 1, error: '' };
}

function cadaFila_(ref, fn) {
  var token = null;
  var campos = null;
  while (true) {
    var opts = { maxResults: 20000, location: ref.location };
    if (token) opts.pageToken = token;
    var respuesta = BigQuery.Jobs.getQueryResults(ref.projectId, ref.jobId, opts);
    if (!respuesta.jobComplete) throw new Error('Resultado incompleto');
    if (!campos && respuesta.schema) {
      campos = respuesta.schema.fields.map(function (f) { return f.name; });
    }
    var rows = respuesta.rows || [];
    for (var r = 0; r < rows.length; r++) {
      var obj = {};
      var celdas = rows[r].f;
      for (var c = 0; c < campos.length; c++) obj[campos[c]] = celdas[c].v;
      fn(obj);
    }
    token = respuesta.pageToken;
    if (!token) break;
  }
}

function Encoder_(spec) {
  this.n = 0;
  this.string = {};
  this.fecha = {};
  this.numero = {};
  var self = this;
  spec.string.forEach(function (c) { self.string[c] = { map: {}, dict: [], idx: [] }; });
  spec.fecha.forEach(function (c) { self.fecha[c] = []; });
  spec.numero.forEach(function (c) { self.numero[c] = []; });
}

Encoder_.prototype.push = function (row) {
  var self = this;
  Object.keys(this.string).forEach(function (c) {
    var bag = self.string[c];
    var v = row[c];
    if (v == null || v === '') { bag.idx.push(-1); return; }
    v = String(v);
    var id = bag.map[v];
    if (id == null) {
      id = bag.dict.length;
      bag.map[v] = id;
      bag.dict.push(v);
    }
    bag.idx.push(id);
  });
  Object.keys(this.fecha).forEach(function (c) {
    self.fecha[c].push(diaUnix_(row[c]));
  });
  Object.keys(this.numero).forEach(function (c) {
    var v = row[c];
    self.numero[c].push(v == null || v === '' ? '' : String(v));
  });
  this.n++;
};

Encoder_.prototype.json = function () {
  var out = { __rows: this.n };
  var self = this;
  Object.keys(this.string).forEach(function (c) {
    var bag = self.string[c];
    out[c] = { d: bag.dict, i: bag.idx.join(',') };
    bag.idx = null;
    bag.map = null;
  });
  Object.keys(this.fecha).forEach(function (c) {
    out[c] = self.fecha[c].join(',');
    self.fecha[c] = null;
  });
  Object.keys(this.numero).forEach(function (c) {
    out[c] = self.numero[c].join(',');
    self.numero[c] = null;
  });
  return JSON.stringify(out);
};

function diaUnix_(iso) {
  if (!iso) return '';
  var p = String(iso).split('-');
  if (p.length < 3) return '';
  return String(Math.round(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000));
}

function asegurarCarpeta_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SNAP_FOLDER');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) {}
  }
  var folder = DriveApp.createFolder(CARPETA_SNAPSHOTS);
  props.setProperty('SNAP_FOLDER', folder.getId());
  return folder;
}

function leerMeta_() {
  var texto = PropertiesService.getScriptProperties().getProperty('SNAP_META') || '';
  if (!texto) return {};
  try { return JSON.parse(texto); } catch (e) { return {}; }
}

function resumenMeta_(meta) {
  var filas = {};
  Object.keys(meta.tablas || {}).forEach(function (nombre) {
    filas[nombre] = meta.tablas[nombre].filas || 0;
  });
  return { actualizado: meta.actualizado, ok: meta.ok, filas: filas, errores: meta.errores || [] };
}

function guardarCacheSnap_(nombre, actualizado, b64) {
  if (!b64 || b64.length > 8 * 1024 * 1024) return;
  var cache = CacheService.getScriptCache();
  var trozo = 90000;
  var n = Math.ceil(b64.length / trozo);
  var lote = {};
  var puestos = 0;
  var base = claveSnap_(nombre, actualizado);
  function vaciar() {
    if (!puestos) return;
    cache.putAll(lote, 21600);
    lote = {};
    puestos = 0;
  }
  for (var i = 0; i < n; i++) {
    lote[base + '-' + i] = b64.substring(i * trozo, (i + 1) * trozo);
    puestos++;
    if (puestos === 80) vaciar();
  }
  lote[base + '-n'] = String(n);
  puestos++;
  vaciar();
}

function leerCacheSnap_(nombre, actualizado) {
  var cache = CacheService.getScriptCache();
  var base = claveSnap_(nombre, actualizado);
  var n = cache.get(base + '-n');
  if (!n) return '';
  var total = Number(n);
  var partes = [];
  for (var i = 0; i < total; i += 80) {
    var claves = [];
    for (var j = i; j < Math.min(total, i + 80); j++) claves.push(base + '-' + j);
    var mapa = cache.getAll(claves);
    for (var k = 0; k < claves.length; k++) {
      if (!mapa[claves[k]]) return '';
      partes.push(mapa[claves[k]]);
    }
  }
  return partes.join('');
}

function claveSnap_(nombre, actualizado) {
  return 'orq-snap3-' + nombre + '-' + (actualizado || '0');
}

function emailUsuario_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}

function isOwner_() {
  var owner = PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || '';
  var email = emailUsuario_();
  if (!owner) return true;
  if (!email) return false;
  return email.toLowerCase() === owner.toLowerCase();
}

function puedeRefrescar_() {
  if (!emailUsuario_()) return true;
  return isOwner_();
}

function usuarioPermitido_() {
  var lista = (PropertiesService.getScriptProperties().getProperty('ALLOWED_USERS') || '').trim();
  if (!lista) return true;
  var email = emailUsuario_().toLowerCase();
  if (!email) return false;
  return lista.split(',').some(function (correo) { return correo.trim().toLowerCase() === email; });
}

function assertAllowed_() {
  if (!usuarioPermitido_()) throw new Error('Sin acceso');
}
