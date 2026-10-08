/**
 * Orquestador Comité Sellers — aplicación web.
 * Los .gs comparten el mismo espacio: una función definida aquí se puede llamar desde otro archivo.
 * Si queda un Código.gs viejo al lado, Apps Script dice «function already defined».
 */

var PROYECTO = 'papyrus-delivery-data';
var TOPE_CSV = 25000;
var SCRIPT_DEV = '19rPasDsuFFiq7kJrTuPFMEqu6meXmSvTVF2JX2zeClX1ACoFvq0OOgl_';

function doGet() {
  if (!usuarioPermitido_()) {
    return HtmlService.createHtmlOutput('<!DOCTYPE html><html lang="es"><body><p>Sin acceso</p></body></html>')
      .setTitle('Sin acceso');
  }
  var plantilla = HtmlService.createTemplateFromFile('index');
  plantilla.esDev = ScriptApp.getScriptId() === SCRIPT_DEV;
  return plantilla.evaluate()
    .setTitle(plantilla.esDev ? 'Orquestador Comité Sellers (dev)' : 'Orquestador Comité Sellers')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(nombre) {
  // El JavaScript vive dentro de <script> en su propio HTML.
  // Apps Script rechaza el archivo si ve un "<" suelto, como en <= o en una etiqueta.
  return HtmlService.createHtmlOutputFromFile(nombre).getContent();
}
