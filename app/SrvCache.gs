/**
 * Guarda la última consulta 15 minutos para que el mismo recorte no vuelva a BigQuery.
 */
function cacheScript() { return CacheService.getScriptCache(); }
function leerJson(clave) {
  var texto = cacheScript().get(clave);
  if (!texto) return null;
  try { return JSON.parse(texto); } catch (e) { return null; }
}
function guardarJson(clave, obj) {
  var texto = JSON.stringify(obj);
  if (texto.length > 95000) return;
  cacheScript().put(clave, texto, CACHE_SEG);
}
function claveCorta(texto) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, texto);
  return bytes.map(function (b) {
    var v = (b + 256) % 256;
    return (v < 16 ? '0' : '') + v.toString(16);
  }).join('');
}
