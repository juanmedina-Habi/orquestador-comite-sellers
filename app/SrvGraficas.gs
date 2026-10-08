/**
 * Una sola consulta por pestaña y por fechas. País, comité y las listas
 * se recortan en la página, sin volver a BigQuery.
 * Actualizar manda forzar y salta la caché de 15 minutos.
 */
function cargarCubo(pedido) {
  pedido = pedido || {};
  var vista = pedido.vista || 'sla';
  var filtro = clausulas(pedido, true);
  var clave = 'orq-cubo2-' + claveCorta(JSON.stringify(claveCubo(pedido)));
  var cubo = pedido.forzar ? null : leerJson(clave);
  if (!cubo) {
    var d = defVista(vista);
    var crudas = consultar(sqlCubo(vista, filtro.where), filtro.params);
    cubo = {
      actualizado: selloBogota(),
      dims: d.cubo,
      filas: crudas.map(function (r) {
        var fila = [r.periodo];
        d.cubo.forEach(function (dim) { fila.push(r[dim] == null ? '' : String(r[dim])); });
        fila.push(Number(r.n) || 0);
        fila.push(Number(r.n_cumple) || 0);
        return fila;
      }),
    };
    guardarJson(clave, cubo);
  }
  return { corte: hoyBogota(), actualizado: cubo.actualizado, dims: cubo.dims, filas: cubo.filas };
}

function claveCubo(pedido) {
  return {
    vista: pedido.vista || 'sla',
    envioDesde: pedido.envioDesde || '',
    envioHasta: pedido.envioHasta || '',
    finDesde: pedido.finDesde || '',
    finHasta: pedido.finHasta || '',
    iniDesde: pedido.iniDesde || '',
    iniHasta: pedido.iniHasta || '',
    nid: pedido.nid || '',
  };
}

function sqlCubo(vista, where) {
  var d = defVista(vista);
  var dims = d.cubo || [];
  var cols = ['FORMAT_DATE("%F", ' + d.periodo + ') AS periodo'];
  dims.forEach(function (dim) {
    cols.push('IFNULL(CAST((' + d[dim] + ') AS STRING), "") AS ' + dim);
  });
  cols.push('COUNT(nid) AS n');
  cols.push('COUNTIF(' + d.meta + ') AS n_cumple');
  var grupos = [];
  var i;
  for (i = 1; i <= dims.length + 1; i++) grupos.push(String(i));
  return 'SELECT ' + cols.join(', ') + ' FROM ' + d.tabla
    + ' WHERE ' + where + ' GROUP BY ' + grupos.join(', ') + ' ORDER BY 1';
}

function cargarSeries(pedido) {
  pedido = pedido || {};
  var filtro = clausulas(pedido);
  var clave = 'orq-s2-' + claveCorta(JSON.stringify(pedidoSerie(pedido)));
  var serie = pedido.forzar ? null : leerJson(clave);
  if (!serie) {
    serie = {
      actualizado: selloBogota(),
      filas: seriesDesde(consultar(sqlSeries(pedido.vista || 'sla', filtro.where), filtro.params)),
    };
    guardarJson(clave, serie);
  }
  return { corte: hoyBogota(), actualizado: serie.actualizado, filas: serie.filas };
}

function recortar(pedido) {
  var serie = cargarSeries(pedido);
  return { corte: serie.corte, actualizado: serie.actualizado, filas: serie.filas, detalle: paginaDetalle(pedido) };
}

function cargarCatalogos(pedido) {
  var vista = (pedido && pedido.vista) || 'sla';
  var dims = dimsDe(vista);
  if (!dims.length) return {};
  var corte = hoyBogota();
  var clave = 'orq-cat4-' + vista + '-' + corte;
  var cat = (pedido && pedido.forzar) ? null : leerJson(clave);
  if (!cat) {
    cat = {};
    dims.forEach(function (dim) {
      cat[dim] = consultar(sqlDistinct(vista, dim), []).map(function (r) { return r.valor; }).filter(Boolean).sort();
    });
    guardarJson(clave, cat);
  }
  return cat;
}

function dimsDe(vista) {
  if (vista === 'sla') return ['equipo', 'propietario', 'dueno', 'respuesta', 'reintentos'];
  if (vista === 'aprobologia') return ['pais', 'propietario', 'agente'];
  if (vista === 'documentos' || vista === 'pricing' || vista === 'remo') return ['agente'];
  return [];
}

function pedidoSerie(pedido) {
  var copia = {};
  Object.keys(pedido || {}).forEach(function (k) {
    if (k === 'pagina' || k === 'forzar') return;
    copia[k] = pedido[k];
  });
  return copia;
}

function sqlSeries(vista, where) {
  var d = defVista(vista);
  return 'SELECT FORMAT_DATE("%F", ' + d.periodo + ') AS periodo, '
    + 'COUNT(nid) AS n, COUNTIF(' + d.meta + ') AS n_cumple '
    + 'FROM ' + d.tabla + ' WHERE ' + where + ' GROUP BY 1 ORDER BY 1';
}

function sqlDistinct(vista, dim) {
  var d = defVista(vista);
  var expr = d[dim];
  if (!expr) throw new Error('Lista desconocida');
  return 'SELECT DISTINCT CAST((' + expr + ') AS STRING) AS valor FROM ' + d.tabla
    + ' WHERE ' + d.poblacion
    + ' AND (' + expr + ') IS NOT NULL AND CAST((' + expr + ') AS STRING) != ""';
}

function seriesDesde(filas) {
  return (filas || []).map(function (r) {
    return {
      periodo: r.periodo,
      n: Number(r.n) || 0,
      n_cumple: Number(r.n_cumple) || 0,
    };
  });
}

