/**
 * Ejecuta la consulta. No agrega cifras: el conteo vive en el SQL.
 */
function consultar(sql, params) {
  var respuesta = BigQuery.Jobs.query({
    query: sql,
    useLegacySql: false,
    timeoutMs: 180000,
    parameterMode: 'NAMED',
    queryParameters: params || [],
    maxResults: 50000,
  }, PROYECTO);
  var ref = respuesta.jobReference;
  var intentos = 0;
  while (!respuesta.jobComplete) {
    if (++intentos > 40) throw new Error('BigQuery no terminó a tiempo');
    Utilities.sleep(500);
    respuesta = BigQuery.Jobs.getQueryResults(ref.projectId, ref.jobId, {
      maxResults: 50000,
      location: ref.location,
    });
  }
  var schema = respuesta.schema;
  var crudas = respuesta.rows ? respuesta.rows.slice() : [];
  while (respuesta.pageToken) {
    respuesta = BigQuery.Jobs.getQueryResults(ref.projectId, ref.jobId, {
      maxResults: 50000,
      location: ref.location,
      pageToken: respuesta.pageToken,
    });
    schema = schema || respuesta.schema;
    if (respuesta.rows) crudas = crudas.concat(respuesta.rows);
  }
  var campos = (schema.fields || []).map(function (f) { return f.name; });
  return crudas.map(function (fila) {
    var obj = {};
    fila.f.forEach(function (celda, i) {
      obj[campos[i]] = celda.v == null ? null : celda.v;
    });
    return obj;
  });
}

function pBool(nombre, valor) {
  return { name: nombre, parameterType: { type: 'BOOL' }, parameterValue: { value: valor ? 'true' : 'false' } };
}
function pString(nombre, valor) {
  return { name: nombre, parameterType: { type: 'STRING' }, parameterValue: { value: String(valor) } };
}
function pDate(nombre, valor) {
  return { name: nombre, parameterType: { type: 'DATE' }, parameterValue: { value: valor } };
}
function pInt(nombre, valor) {
  return { name: nombre, parameterType: { type: 'INT64' }, parameterValue: { value: String(valor) } };
}
function pArray(nombre, valores) {
  return {
    name: nombre,
    parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
    parameterValue: { arrayValues: valores.map(function (v) { return { value: v }; }) },
  };
}
