# NERVA y UNIDAD

NERVA se desarrolla como lenguaje independiente en este repositorio. La
extracción inicial recuperó el runtime 0.2.0 que UNIDAD empaqueta en
`src/ia_propia/assets/nerva/`; [provenance.json](../provenance.json) conserva
el commit de origen y los SHA-256 históricos de esos siete archivos.

Este repositorio ya desarrolla **NERVA 0.3.0**, con módulos, registros,
colecciones, funciones del anfitrión y herramientas de proyectos. Los archivos
actuales del motor han evolucionado respecto a la extracción. **UNIDAD
conserva su copia 0.2.0 y sus adaptadores actuales**; no necesita instalar
este paquete para mantener los dos recorridos descritos aquí.

## Selección de tokens

`src/conversation_decoder.nv` recibe los logits calculados por el Transformer y
selecciona un token. El cálculo neuronal del Transformer permanece en PyTorch.
El programa maneja exclusiones, temperatura, top-k, top-p y penalización de
repetición. Los identificadores de tokens y las puntuaciones vienen del anfitrión.

Puede ejecutarse de forma independiente con datos explícitos:

```sh
node src/nerva.mjs run src/conversation_decoder.nv \
  --inputs examples/decoder-inputs.json --json
```

El resultado de ese ejemplo contiene `["token", 3]`: el token 2 tiene la mayor
puntuación pero está excluido. El CLI actual informa `version: "0.3.0"`,
mientras el programa conserva el encabezado `nerva 0.2` y su registro
`version: "0.2"`. `src/conversation_worker.mjs` permite reutilizar
un proceso para varias decisiones. Recibe un objeto JSON por línea con exactamente
estos campos:

```json
{
  "scores": [0.1, 0.2, 5.0, 1.0],
  "excluded": [2],
  "generated": [],
  "temperature": 0,
  "top_k": 0,
  "top_p": 1,
  "repetition_penalty": 1,
  "draw": 0
}
```

Responde una línea `{"token":3}` por decisión. `draw` es un valor en `[0,1)`
producido por el RNG del anfitrión. El worker ejecuta el programa fijo y limita
su entrada a 8 MiB de caracteres pendientes y 1024 decisiones por proceso. Una
entrada incompleta o inválida produce un registro de error y código de salida 1.

En UNIDAD, `ia_propia.conversation.nerva_decoder.NervaDecoder` administra ese
proceso y `ConversationEngine(..., decoder_backend="nerva")` selecciona el
recorrido. El selector se configura desde el anfitrión; los mensajes no aportan
programas ni rutas. La semilla se reproduce dentro de un backend; el muestreo no
promete los mismos tokens entre los RNG de Torch y NERVA.

## Inferencia del modelo de caracteres

`src/language_rnn.nv` ejecuta la recurrencia `tanh`, proyección de salida y
decisión greedy del char-RNN propio de UNIDAD con tensores `f64`.
`ia_propia.language.nerva_backend.generate_nerva` valida y prepara el artefacto,
codifica el prompt y entrega al programa entradas llamadas `Wxh`, `Whh`, `Why`,
`bh`, `by`, `unknown_projection`, `unknown_bias`, `tokens`, `character_tokens` y
`count`. El resultado es un registro `["continuation", texto]`.

Este programa necesita pesos y tokenizador preparados por el adaptador; no es
un ejemplo que pueda ejecutar sin ellos. El adaptador admite temperatura cero
y conserva la identidad y procedencia del artefacto. UNIDAD ya incluye un modelo
de demostración para comprobarlo desde su propia raíz:

```sh
PYTHONPATH=src python -m ia_propia.language generate \
  --model src/ia_propia/assets/language-demo.json \
  --backend nerva --temperature 0 --prompt "Hola" --length 64
```

La equivalencia numérica de `f64` cerca de empates requiere comprobación con los
pesos concretos. La conexión existente no demuestra mejora de conversación ni
de velocidad.

## Procedencia histórica

Para informar diferencias respecto a la extracción inicial y a la copia
local de UNIDAD, desde NERVA:

```sh
npm run verify:origin -- ../unidad --report
```

El comando compara los siete archivos históricos con sus hashes de extracción
y, si se suministra la ruta, con la copia de UNIDAD. No copia ni sobrescribe
archivos. El informe incluye `matchesOrigin`, `matchesUnidad` y
`unidadMatchesOrigin`. En 0.3 es normal que el motor actual ya no coincida
con 0.2: esas diferencias documentan evolución y no prueban por sí solas
incompatibilidad de comportamiento.

Con `--report`, una diferencia informada no produce un código de fallo;
un error al leer archivos sí. Sin esa opción:

```sh
npm run verify:origin -- ../unidad
```

se comprueba igualdad exacta con la base y el código de salida es 1 si hay
diferencias. `provenance.json` sigue registrando 0.2.0; no se cambian sus
hashes para describir 0.3 como una extracción intacta.

## Incorporar 0.3 a UNIDAD

La [referencia del lenguaje](lenguaje.md#migración-desde-02) describe los
cambios de contrato. Una actualización de UNIDAD necesita revisar juntos
el motor, el empaquetado y sus adaptadores:

1. **Archivos del CLI.** `nerva.mjs` 0.3 importa `cli.mjs`, que utiliza
   `project.mjs`, `runtime.mjs`, `parser.mjs` y `tensor.mjs`.
   El adaptador de caracteres actual copia sólo
   `parser.mjs`, `tensor.mjs`, `runtime.mjs` y `nerva.mjs`, además
   de `language_rnn.nv`. Hay que añadir los archivos nuevos a esa lista
   si conserva el recorrido del CLI. La distribución actual incluye
   `nerva/*.mjs` y `nerva/*.nv`; hay que comprobar la instalación real
   y la copia a temporales, además del árbol de desarrollo.
2. **Versiones y esquema de salida.** El adaptador de caracteres exige
   `NERVA_VERSION = "0.2.0"` y registros `"0.2"`.
   NERVA 0.3 informa `VERSION = "0.3.0"`; los programas actuales
   con encabezado `nerva 0.2` siguen produciendo registros `"0.2"`.
   Actualiza el contrato esperado explícitamente. `run --json` conserva
   `{version, records, steps}`; `--profile` añade
   `tensorOperations` y `--globals` añade globales.
3. **Presupuestos.** Los valores predeterminados siguen siendo 200.000
   pasos y 20.000.000 operaciones; ahora el anfitrión puede ampliarlos
   con enteros seguros positivos. Conserva los límites explícitos del
   adaptador y sus timeouts si ése sigue siendo el contrato de UNIDAD.
   El presupuesto tensorial está aislado por ejecución y se informa en
   `result.tensorOperations` para la API JavaScript.
4. **Worker y programas.** El worker continúa devolviendo
   `{"token": entero}` y necesita el selector en su misma carpeta.
   Su recorrido directo requiere `parser.mjs`, `tensor.mjs`,
   `runtime.mjs`, `conversation_worker.mjs` y
   `conversation_decoder.nv`. Si los programas futuros importan módulos,
   sus fuentes también deben estar disponibles para el cargador elegido.
   No cambies los encabezados de los programas sin revisar los registros
   esperados por sus consumidores.

La API `prepareProgram` permite analizar el selector una vez y ejecutar
con entradas nuevas, omitiendo globales con `captureGlobals: false`.
Cada ejecución crea estado nuevo; esa API no convierte el worker actual
en una sesión de entrenamiento persistente. Cualquier optimización del
worker necesita comparar decisiones, errores y presupuestos del recorrido
integrado. No hay funciones `host` registradas automáticamente en UNIDAD.

Después de actualizar deliberadamente esa copia, ejecutar desde UNIDAD las
pruebas pertinentes con sus dependencias instaladas:

```sh
PYTHONPATH=src python -m unittest discover -s tests -p 'test_nerva_*.py'
PYTHONPATH=src python -m unittest discover -s tests -p 'test_conversation_cache_decoder.py'
```

La última suite necesita las dependencias conversacionales de UNIDAD. No se
transfieren pesos ni se inicia entrenamiento de UNIDAD al desarrollar este
repositorio. Las pruebas de NERVA 0.3 y sus ejemplos verifican capacidades
del lenguaje; no certifican calidad conversacional ni una mejora de la IA
de UNIDAD.

## Evidencia de los experimentos

`experiments/results/*.json` conserva los informes iniciales ejecutados
con 0.2.0. Las nuevas corridas de 0.3.0 están separadas en
`experiments/results/0.3.0/` y registran su versión y protocolo.
No se presentan los resultados históricos como mediciones del motor nuevo.
Los ejemplos de regresión, síntesis y planificación son tareas acotadas;
los prototipos de rendimiento tienen los alcances descritos en sus informes.
