/**
 * Cada consulta va directo a una vista, sin armar las seis juntas.
 * BigQuery no alcanza a planear la vista si se envuelve en otra consulta grande.
 * La semana empieza el lunes. Una hora nula no cuenta como cumple.
 */

function defVista(vista) {
  var corte = 'CURRENT_DATE("America/Bogota")';
  var hastaFin = 'fecha_fin IS NOT NULL AND DATE(fecha_fin) <= ' + corte;
  var comite = 'IF(ciclo_en_curso = 1, "Si", "No")';
  if (vista === 'sla') return {
    tabla: '`papyrus-delivery-data.idm_tech.sla_orquestador`',
    poblacion: 'fecha_respuesta_orquestador IS NOT NULL AND DATE(fecha_respuesta_orquestador) <= ' + corte,
    periodo: 'DATE_TRUNC(DATE(fecha_respuesta_orquestador), MONTH)',
    meta: 'horas_habiles <= 8',
    pais: 'pais_hubspot',
    inicio: 'DATE(fecha_envio_seller)',
    fin: 'DATE(fecha_respuesta_orquestador)',
    envio: 'DATE(fecha_envio_seller)',
    propietario: 'propietario_de_aprobacion_final',
    equipo: 'equipo_sellers',
    dueno: 'propietario_del_negocio',
    respuesta: "CASE WHEN LOWER(respuesta) = 'inmueble aprobado' THEN 'Aprobado' WHEN LOWER(respuesta) IN ('descartado', 'descartado comite', 'descartado por comité') THEN 'Descartado' ELSE respuesta END",
    reintentos: "IF(reintentos = 0, 'No tuvo Reintentos', IF(reintentos IS NULL, NULL, 'Tuvo Reintentos'))",
    etapa: 'fase_rechazo',
    cubo: ['pais', 'propietario', 'equipo', 'dueno', 'respuesta', 'reintentos'],
  };
  if (vista === 'documentos') return baseMicro(
    "tipo_tarea = 'Revision de documentos' AND respuesta_doc_pais IS NOT NULL AND " + hastaFin,
    'horas_habiles <= 2', 'DATE_TRUNC(DATE(fecha_fin), WEEK(MONDAY))', comite
  );
  if (vista === 'pricing') return baseMicro(
    "tipo_tarea IN ('Pricing', 'Pricing automático', 'Pricing manual') AND flag_doc_avanza AND flag_checks_avanza AND " + hastaFin,
    'horas_habiles <= 4', 'DATE_TRUNC(DATE(fecha_fin), WEEK(MONDAY))', comite, 'tipo_tarea'
  );
  if (vista === 'remo') return baseMicro(
    "tipo_tarea = 'Revision de Remodelación' AND flag_doc_avanza AND " + hastaFin,
    'horas_habiles <= 4', 'DATE_TRUNC(DATE(fecha_fin), WEEK(MONDAY))', comite
  );
  if (vista === 'aprobologia') return {
    tabla: '`papyrus-delivery-data.idm_tech.micro_sla_orquestador`',
    poblacion: "tipo_tarea = 'Aprobologia' AND flag_doc_avanza AND flag_remo_avanza AND flag_checks_avanza AND flag_pricing_avanza AND flag_hesh_avanza"
      + ' AND ' + hastaFin,
    periodo: 'DATE_TRUNC(DATE(fecha_fin), MONTH)',
    meta: 'horas_habiles <= 2',
    pais: 'pais',
    inicio: 'DATE(fecha_inicio)',
    fin: 'DATE(fecha_fin)',
    envio: 'DATE(fecha_envio_seller)',
    comite: comite,
    comiteSi: 'ciclo_en_curso = 1',
    comiteNo: 'IFNULL(ciclo_en_curso, 0) != 1',
    propietario: 'propietario_de_aprobacion_final',
    agente: 'owner',
    estado: "IF(flag_aprobologia_avanza, 'Aprobado', 'Rechazado')",
    cubo: ['pais', 'comite', 'propietario', 'agente', 'estado'],
  };
  if (vista === 'inmo') return {
    tabla: '`papyrus-delivery-data.idm_tech.funnel_orquestador_inmo`',
    poblacion: 'fin_general IS NOT NULL AND DATE(fin_general) <= ' + corte,
    periodo: 'DATE(fin_general)',
    meta: 'horas_habiles <= 6',
    pais: 'pais_hubspot',
    inicio: 'DATE(fecha_envio_seller)',
    fin: 'DATE(fin_general)',
    envio: 'DATE(fecha_envio_seller)',
    etapa: "CASE etapa WHEN 'COMPLETED' THEN 'Aprobado' WHEN 'IN_PROGRESS' THEN 'En proceso' WHEN 'REJECTED' THEN 'Rechazado' ELSE etapa END",
    automatizacion: 'automatizacion',
    cubo: ['pais', 'etapa', 'automatizacion'],
  };
  throw new Error('Pestaña desconocida');
}

function baseMicro(poblacion, meta, periodo, comite, tipo) {
  return {
    tabla: '`papyrus-delivery-data.idm_tech.micro_sla_orquestador`',
    poblacion: poblacion,
    periodo: periodo,
    meta: meta,
    pais: 'pais',
    inicio: 'DATE(fecha_inicio)',
    fin: 'DATE(fecha_fin)',
    envio: 'DATE(fecha_envio_seller)',
    comite: comite,
    comiteSi: 'ciclo_en_curso = 1',
    comiteNo: 'IFNULL(ciclo_en_curso, 0) != 1',
    agente: 'owner',
    tipo: tipo || '',
    cubo: ['pais', 'comite', 'agente'],
  };
}

function clausulas(pedido, soloFechas) {
  pedido = pedido || {};
  var vista = pedido.vista || 'sla';
  var d = defVista(vista);
  var where = [d.poblacion];
  var params = [];
  function eq(expr, nombre, valor) {
    if (!valor || !expr) return;
    where.push('(' + expr + ') = @' + nombre);
    params.push(pString(nombre, valor));
  }
  function rango(expr, nombre, desde, hasta) {
    if (!expr || (!desde && !hasta)) return;
    where.push('(' + expr + ' IS NOT NULL'
      + ' AND (@sin' + nombre + 'Desde OR ' + expr + ' >= @' + nombre + 'Desde)'
      + ' AND (@sin' + nombre + 'Hasta OR ' + expr + ' <= @' + nombre + 'Hasta))');
    params.push(pBool('sin' + nombre + 'Desde', !desde));
    params.push(pDate(nombre + 'Desde', desde || '1970-01-01'));
    params.push(pBool('sin' + nombre + 'Hasta', !hasta));
    params.push(pDate(nombre + 'Hasta', hasta || '1970-01-01'));
  }
  function lista(expr, nombre, valores) {
    valores = valores || [];
    if (!expr || !valores.length) return;
    where.push('IFNULL(CAST((' + expr + ') AS STRING), "") IN UNNEST(@' + nombre + ')');
    params.push(pArray(nombre, valores.map(String)));
  }
  rango(d.envio, 'envio', pedido.envioDesde, pedido.envioHasta);
  rango(d.fin, 'fin', pedido.finDesde, pedido.finHasta);
  rango(d.inicio, 'ini', pedido.iniDesde, pedido.iniHasta);
  if (pedido.nid) {
    where.push('CAST(nid AS STRING) LIKE CONCAT("%", @nid, "%")');
    params.push(pString('nid', String(pedido.nid)));
  }
  if (soloFechas) return { vista: vista, def: d, where: where.join(' AND '), params: params };
  if (pedido.periodo && /^\d{4}-\d{2}-\d{2}$/.test(String(pedido.periodo))) {
    where.push('FORMAT_DATE("%F", ' + d.periodo + ') = @periodoBarra');
    params.push(pString('periodoBarra', String(pedido.periodo)));
  }
  eq(d.pais, 'pais', pedido.pais);
  if (pedido.cumple === 'Si') where.push('(' + d.meta + ')');
  if (pedido.cumple === 'No') where.push('NOT COALESCE(' + d.meta + ', FALSE)');
  if (pedido.comite === 'Si' && d.comiteSi) where.push('(' + d.comiteSi + ')');
  if (pedido.comite === 'No' && d.comiteNo) where.push('(' + d.comiteNo + ')');
  lista(d.agente, 'agente', pedido.agente);
  if (vista === 'aprobologia') {
    eq(d.estado, 'estado', pedido.estado);
    lista(d.propietario, 'propietario', pedido.propietario);
  } else {
    eq(d.etapa, 'etapa', pedido.etapa);
    eq(d.automatizacion, 'automatizacion', pedido.automatizacion);
    lista(d.propietario, 'propietario', pedido.propietario);
    lista(d.equipo, 'equipo', pedido.equipo);
    lista(d.dueno, 'dueno', pedido.dueno);
    lista(d.respuesta, 'respuesta', pedido.respuesta);
    lista(d.reintentos, 'reintentos', pedido.reintentos);
  }
  return { vista: vista, def: d, where: where.join(' AND '), params: params };
}
