# NERVA y UNIDAD

NERVA se desarrolla como lenguaje independiente en este repositorio. La
extracción inicial conserva byte a byte el runtime 0.2.0 que UNIDAD empaqueta en
`src/ia_propia/assets/nerva/`; [provenance.json](../provenance.json) identifica el
commit de origen y los SHA-256 de los siete archivos. UNIDAD conserva sus archivos
y no necesita instalar este paquete para mantener sus recorridos actuales.

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
puntuación pero está excluido. `src/conversation_worker.mjs` permite reutilizar
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

## Actualizaciones entre repositorios

Para revisar la base recuperada, desde NERVA:

```sh
npm run verify:origin -- ../unidad
```

El comando compara cada archivo con su hash de extracción y con la copia local
de UNIDAD. No modifica ninguno de los dos proyectos. Si hay diferencias, informa
qué archivo cambió y termina con código 1; es una auditoría de la base original,
no una prueba de incompatibilidad de toda ampliación futura.

Cuando se decida incorporar una versión nueva en UNIDAD, se deben revisar juntos
`parser.mjs`, `tensor.mjs`, `runtime.mjs`, `nerva.mjs`, `conversation_worker.mjs`
y los programas `.nv`. El worker necesita el selector en su misma carpeta; los
adaptadores Python copian una lista explícita de recursos a directorios
temporales, y `pyproject.toml` los incluye en la distribución. Añadir módulos
nuevos puede requerir actualizar ambas listas.

Después de actualizar deliberadamente esa copia, ejecutar desde UNIDAD las
pruebas pertinentes con sus dependencias instaladas:

```sh
PYTHONPATH=src python -m unittest discover -s tests -p 'test_nerva_*.py'
PYTHONPATH=src python -m unittest discover -s tests -p 'test_conversation_cache_decoder.py'
```

La última suite necesita las dependencias conversacionales de UNIDAD. No se
transfieren pesos ni se inicia entrenamiento de UNIDAD al preparar este repositorio.
