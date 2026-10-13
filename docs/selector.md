# Selector especializado opcional

Esta extensión ejecuta únicamente `conversation_decoder.nv` con SHA-256
`97d5b38f4e3aa0277eec0d37debbfdbba4e6b814eb281b1cbcd05fc9a2bfec4d`.
La extensión no cambia `runProgram`, `runSource2` ni la CLI de cada versión.
UNIDAD conserva sus siete archivos 0.2 originales; NERVA independiente avanzó
a 0.3 durante este trabajo y se conservaron todos esos cambios ajenos.
`provenance.json` conserva los hashes históricos, sin reescribirlos. Node.js 18+, sin dependencias nuevas.

```js
import {readFileSync} from 'node:fs';
import {prepareTokenSelector} from './src/token_selector.mjs';
const select = prepareTokenSelector(readFileSync('./src/conversation_decoder.nv', 'utf8'));
const token = select({scores: [3, 2, 1], excluded: [], generated: [],
  temperature: 0, top_k: 0, top_p: 1, repetition_penalty: 1, draw: 0});
```

`prepareTokenSelector` valida sintaxis y hash una vez. Devuelve una función que
acepta exactamente las ocho entradas numéricas del worker y devuelve un entero.
Su segundo argumento opcional admite `stepLimit` y `operationLimit` con los
rangos acotados del intérprete 0.2, también cuando se usa desde 0.3. La nueva API no devuelve variables globales.
Usa los mismos `tensor` f64, `selectToken` y `serialize`: conserva algoritmos,
desempates, validaciones y cargos de operaciones. Conserva también los fallos
por presupuesto reducido. El código `.nv` modificado se rechaza explícitamente.
No acepta programas, rutas, módulos, pesos ni comandos dentro de una petición.

El formato acotado admite hasta 65.536 puntuaciones, 4.096 índices por lista y
controles finitos. Esos máximos mantienen entrada, profundidad y serialización
dentro de los límites del intérprete; la salida es sólo un índice. El worker
opcional `conversation_worker_fast.mjs` conserva el protocolo JSON por líneas,
8 MiB por petición pendiente, 1.024 decisiones y errores terminales.

La implementación omite la exportación general de globales y la evaluación del
AST en cada token. Conserva la serialización del tensor para mantener exactamente
el presupuesto de operaciones anterior. Esto difiere del prototipo que suprimía
también ese cargo. No utiliza el kernel fusionado sin presupuestos ni gradientes.

UNIDAD lo expone mediante `decoder_backend="nerva-fast"` / `--decoder-backend
nerva-fast` y la configuración anfitriona `conversation_decoder`. Torch sigue
predeterminado. Los backends `torch` y `nerva` conservan su comportamiento.
La red y la caché permanecen en Torch. Python conserva semilla local, tiempo
máximo, comprobación del índice, aislamiento por respuesta y limpieza del proceso.

Verificación y mediciones:

```sh
npm test
npm run verify:origin -- --report
node scripts/verify-selector.mjs ../UNIDAD
node experiments/selector.mjs private/selector-kernel.json
```

La medición aislada incluye calentamiento, cinco rondas y orden rotativo para
vocabularios de 2.048 y 8.192. No mide respuestas completas. Las comparaciones
completas viven en UNIDAD, en `docs/nerva-selector-20261013/`, con C7,
`reference-wiki1` (predeterminado al iniciar) y el candidato de memoria separado.
Se publican resultados y limitaciones antes de decidir su adopción.

La misma extensión se verifica con los runtimes 0.2.0 y 0.3.0. En 0.3 respeta
los contextos de presupuesto del anfitrión y cobra los tres pasos adicionales
de invocación introducidos por esa versión. El programa fijo conserva su
encabezado 0.2. No importa módulos ni registra funciones del anfitrión. Los
getters, símbolos, prototipos personalizados y arrays dispersos se rechazan
sin ejecutar código del anfitrión. Versiones futuras requieren una revisión
explícita; no se supone compatibilidad por compartir el nombre NERVA.

## Resultado de generación en UNIDAD

La corrida final de UNIDAD `ecf03da` conservó 468 respuestas medidas y 117 pares
NERVA original/optimizada con salidas idénticas. Medianas por diez consultas:

| Modelo | NERVA original | NERVA especializada | Torch con caché |
|---|---:|---:|---:|
| C7 | 4,617 s | 3,669 s | 0,912 s |
| SOVENGI predeterminado | 7,431 s | 6,740 s | 4,417 s |
| Candidato de memoria | 8,099 s | 7,392 s | 4,913 s |

Se recomienda mantener Torch con caché predeterminado y esta ruta como opción.
Los pesos y el runtime 0.2 de UNIDAD no se modificaron.
[Informe y respuestas completas en UNIDAD](https://github.com/guadalupejuan001-code/UNIDAD/blob/work/nerva-selector-performance-20261013/docs/nerva-selector-20261013/README.md).

La [medición aislada de esta extensión con runtime 0.3](../experiments/results/selector-0.3.0.json)
usa otra máquina y sólo mide Node. No se mezcla con los tiempos de generación
0.2 de UNIDAD ni se presenta como una migración completa ya evaluada.
