/**
 * Fechas de Bogotá, rótulos y el formato del CSV.
 */
var CACHE_SEG = 900;

function miles(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function hoyBogota() {
  return Utilities.formatDate(new Date(), 'America/Bogota', 'yyyy-MM-dd');
}
function selloBogota() {
  return Utilities.formatDate(new Date(), 'America/Bogota', "yyyy-MM-dd'T'HH:mm:ss") + '-05:00';
}
function fechaCorta(iso) {
  if (!iso) return '';
  var p = String(iso).split('-');
  return Number(p[2]) + '/' + Number(p[1]) + '/' + p[0];
}
function rotuloPais(p) {
  return p === 'Mexico' ? 'México' : (p || '');
}
function celdaCsv(v) {
  var s = v == null ? '' : String(v);
  return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function tiempoHabil(horas) {
  if (horas == null || horas === '') return '—';
  var h = Number(horas);
  if (isNaN(h)) return '—';
  var dias = Math.floor(h / 24);
  var hh = Math.floor(h % 24);
  var mm = Math.floor((h - Math.floor(h)) * 60);
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  if (dias > 0) return dias + 'd ' + pad(hh) + 'h :' + pad(mm) + 'm';
  return pad(hh) + 'h :' + pad(mm) + 'm';
}
