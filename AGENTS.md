# Desarrollo de NERVA

El creador quiere que NERVA alcance la máxima capacidad general en código:
«quiero que nerva sea omnipotente en el codigo». Esa dirección guía la evolución
hacia programación general, interoperabilidad, aprendizaje y transformación de
programas; las capacidades disponibles se siguen declarando por evidencia.

La continuación pide implementar NERVA para programación profesional. Prioriza
proyectos modulares ejecutables, datos estructurados, interoperabilidad explícita,
pruebas y empaquetado reproducible. Los ejemplos y experimentos deben funcionar
con la versión publicada, conservando la evidencia histórica por versión.

- Lee README.md y docs/lenguaje.md para conocer el contrato existente.
- Desarrolla el lenguaje aquí. UNIDAD conserva una copia empaquetada; una
  actualización allí requiere revisar sus adaptadores y pruebas de integración.
- Conserva provenance.json como registro de la extracción inicial. No reescribas
  los hashes históricos para presentar modificaciones nuevas como originales.
- Mantén el paquete privado, sin asignar una licencia pública por cuenta propia.
- Conserva la API y CLI existentes cuando amplíes capacidades; documenta los
  cambios de contrato y versión que sean necesarios.
- Para cambios de código, ejecuta npm test y los ejemplos afectados. El runtime
  debe seguir funcionando en Node.js 18+ sin dependencias npm.
- Comprueba el aprendizaje y rendimiento con resultados reales. Las pruebas del
  lenguaje no acreditan calidad conversacional ni capacidades generales de IA.
- Mantén pesos, checkpoints y datos personales en private/ o rutas excluidas de Git.
