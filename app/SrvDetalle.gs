/**
 * Tabla de nid: una página de 50 filas y el CSV del recorte.
 */
function paginaDetalle(pedido) {
  pedido = pedido || {};
  var filtro = clausulas(pedido);
  var vista = pedido.vista || 'sla';
  var pagina = Math.max(0, Number(pedido.pagina) || 0);
  var clave = 'orq-d-' + claveCorta(JSON.stringify(pedidoSerie(pedido)) + '|' + pagina);
  var guardado = pedido.forzar ? null : leerJson(clave);
  if (guardado) return guardado;
  var params = filtro.params.concat([pInt('limite', 50), pInt('salto', pagina * 50)]);
  var crudas = consultar(sqlDetalle(vista, filtro.where), params);
  var total = crudas.length ? Number(crudas[0].total_filas) || 0 : 0;
  if (!crudas.length && pagina > 0) {
    total = Number(consultar(sqlTotal(vista, filtro.where), filtro.params)[0].total) || 0;
    var ultima = Math.max(0, Math.ceil(total / 50) - 1);
    if (pagina > ultima) return paginaDetalle(Object.assign({}, pedido, { pagina: ultima, forzar: true }));
  }
  var salida = { total: total, pagina: pagina, filas: crudas.map(filaDetalle) };
  guardarJson(clave, salida);
  return salida;
}

function csvDetalle(pedido) {
  var tabla = tablaExport(pedido);
  if (tabla.error) return { error: tabla.error };
  var lineas = [tabla.encabezado.join(';')];
  tabla.cuerpo.forEach(function (fila) {
    lineas.push(fila.map(celdaCsv).join(';'));
  });
  var vista = (pedido && pedido.vista) || 'sla';
  return { csv: lineas.join('\n'), nombre: 'orquestador-' + vista + '.csv' };
}

function hojaDetalle(pedido) {
  var tabla = tablaExport(pedido);
  if (tabla.error) return { error: tabla.error };
  var vista = (pedido && pedido.vista) || 'sla';
  var nombre = 'Orquestador ' + vista;
  if (pedido && pedido.periodo) nombre += ' ' + pedido.periodo;
  var ss = SpreadsheetApp.create(nombre);
  var hoja = ss.getSheets()[0];
  hoja.setName('Detalle');
  var filas = [tabla.encabezado].concat(tabla.cuerpo);
  var ancho = tabla.encabezado.length;
  var i = 0;
  while (i < filas.length) {
    var corte = filas.slice(i, i + 500);
    hoja.getRange(i + 1, 1, corte.length, ancho).setValues(corte);
    i += corte.length;
  }
  hoja.setFrozenRows(1);
  hoja.getRange(1, 1, 1, ancho).setFontWeight('bold');
  try {
    DriveApp.getFileById(ss.getId()).setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {}
  return { url: ss.getUrl(), nombre: nombre };
}

function tablaExport(pedido) {
  pedido = pedido || {};
  var filtro = clausulas(pedido);
  var vista = pedido.vista || 'sla';
  var total = Number(consultar(sqlTotal(vista, filtro.where), filtro.params)[0].total) || 0;
  if (total > TOPE_CSV) {
    return {
      error: 'Hay ' + miles(total) + ' nid en este recorte. Acota un filtro: la descarga llega hasta ' + miles(TOPE_CSV) + '.',
    };
  }
  if (!total) return { error: 'No hay nid con estos filtros.' };
  var params = filtro.params.concat([pInt('limite', TOPE_CSV), pInt('salto', 0)]);
  var filas = consultar(sqlDetalle(vista, filtro.where), params).map(filaDetalle);
  var aprob = vista === 'aprobologia';
  var encabezado = aprob
    ? ['Nid', 'País', 'Inicio', 'Fin', 'Horas hábiles', 'Cumple', 'Tiempo hábil', 'Agente', 'Comité en curso', 'Estado', 'Propietario']
    : ['Nid', 'País', 'Inicio', 'Fin', 'Horas hábiles', 'Cumple', 'Etapa', 'Tipo'];
  var cuerpo = filas.map(function (f) {
    return aprob
      ? [f.nid, rotuloPais(f.pais), fechaCorta(f.inicio), fechaCorta(f.fin), f.horas == null ? '' : f.horas, f.cumple, tiempoHabil(f.horas), f.agente, f.comite, f.estado, f.propietario]
      : [f.nid, rotuloPais(f.pais), fechaCorta(f.inicio), fechaCorta(f.fin), f.horas == null ? '' : f.horas, f.cumple, f.etapa, f.tipo];
  });
  return { encabezado: encabezado, cuerpo: cuerpo };
}

function sqlTotal(vista, where) {
  var d = defVista(vista);
  return 'SELECT COUNT(nid) AS total FROM ' + d.tabla + ' WHERE ' + where;
}

function sqlDetalle(vista, where) {
  var d = defVista(vista);
  function col(expr, alias) {
    return (expr ? '(' + expr + ')' : 'CAST(NULL AS STRING)') + ' AS ' + alias;
  }
  return 'SELECT CAST(nid AS STRING) AS nid, '
    + col(d.pais, 'pais') + ', '
    + 'FORMAT_DATE("%F", ' + d.inicio + ') AS fecha_inicio, '
    + 'FORMAT_DATE("%F", ' + d.fin + ') AS fecha_fin, '
    + 'horas_habiles, IF(' + d.meta + ', "Si", "No") AS cumple, COUNT(nid) OVER() AS total_filas, '
    + col(d.etapa, 'etapa') + ', '
    + col(d.tipo, 'tipo_tarea') + ', '
    + col(d.agente, 'agente') + ', '
    + col(d.comite, 'comite') + ', '
    + col(d.estado, 'estado') + ', '
    + col(d.propietario, 'propietario') + ' '
    + 'FROM ' + d.tabla + ' WHERE ' + where + ' '
    + 'ORDER BY ' + d.fin + ' DESC, nid DESC LIMIT @limite OFFSET @salto';
}

function filaDetalle(f) {
  return {
    nid: f.nid == null ? '' : String(f.nid),
    pais: f.pais || '',
    inicio: f.fecha_inicio || '',
    fin: f.fecha_fin || '',
    horas: f.horas_habiles == null || f.horas_habiles === '' ? null : Number(f.horas_habiles),
    cumple: f.cumple || '',
    etapa: f.etapa || '',
    tipo: f.tipo_tarea || '',
    agente: f.agente || '',
    comite: f.comite || '',
    estado: f.estado || '',
    propietario: f.propietario || '',
  };
}
