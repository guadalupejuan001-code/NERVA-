# NERVA

Lenguaje de programación privado para trabajar con tensores, construir modelos
pequeños y ejecutar aprendizaje local en CPU. Esta base independiente recupera
**NERVA 0.2.0** del repositorio UNIDAD: ahora el lenguaje tiene su propio paquete,
comandos, ejemplos, documentación y pruebas.

El intérprete está escrito en JavaScript y ejecuta programas `.nv`. Requiere
**Node.js 18 o posterior**, sin dependencias npm ni acceso a Internet durante la
ejecución. El paquete está marcado como privado.

## Empezar

```sh
git clone https://github.com/guadalupejuan001-code/NERVA-.git nerva
cd nerva
node src/nerva.mjs --version
npm run demo
npm run train:regression
npm run train:classification
```

No hace falta ejecutar `npm install`. Para escribir un programa:

```nerva
nerva 0.2

const x = tensor64([1, 2, 3])
const resultado = x * 2 + 1
print(resultado)
```

Guárdalo como `mi_programa.nv` y ejecútalo:

```sh
node src/nerva.mjs check mi_programa.nv
node src/nerva.mjs run mi_programa.nv
node src/nerva.mjs run mi_programa.nv --json
```

`check` comprueba la sintaxis; los errores de nombres, tipos y dimensiones se
comprueban al ejecutar. `run --json` devuelve `{version, records, steps}` y los
errores del CLI salen por stderr con línea y columna cuando están disponibles.
También puedes usar `npm run nerva -- run mi_programa.nv`.

## Qué puede hacer hoy

- Variables, constantes, funciones, condicionales y bucles con ámbitos léxicos.
- Tensores `f32` y `f64`, operaciones matriciales y activaciones.
- Diferenciación automática, pérdidas MSE y entropía cruzada, entrenamiento SGD.
- Semillas reproducibles y exportación/restauración de checkpoints de parámetros.
- Entradas JSON del programa anfitrión y selección de tokens con controles de generación.
- Uso como biblioteca JavaScript mediante `runProgram`.

La [referencia del lenguaje](docs/lenguaje.md) describe la sintaxis, funciones y
límites disponibles. El motor tiene presupuestos de ejecución; está pensado para
experimentos acotados en CPU. Todavía no incorpora módulos `.nv`, un compilador
nativo, GPU ni optimizadores como Adam.

## Ejemplos de aprendizaje

| Programa | Qué comprueba |
| --- | --- |
| [hola.nv](examples/hola.nv) | Funciones y multiplicación matricial: produce `[4, 10]`. |
| [regresion.nv](examples/regresion.nv) | Aprende `y = 2*x + 1` desde parámetros cero y comprueba la predicción para `x=3`. |
| [clasificacion.nv](examples/clasificacion.nv) | Entrena un clasificador lineal y comprueba cuatro puntos conocidos. |

En la ejecución local de estos ejemplos, la pérdida de regresión pasó de `9` a
`4.15e-20`, y la de clasificación de `0.6931` a `0.01126`. Son ejercicios pequeños
con datos explícitos; la clasificación comprueba ajuste a sus propios puntos de
entrenamiento. Estos resultados no evalúan conversación ni una IA general.

Los programas emiten checkpoints en sus resultados. Para guardarlos:

```sh
node src/nerva.mjs run examples/regresion.nv --out private/checkpoints
```

La carpeta `private/` está excluida de Git. Un checkpoint conserva los parámetros,
sus dimensiones y dtype; no guarda el estado completo de una corrida.

## Usarlo desde JavaScript

```js
import { runProgram, VERSION } from './src/runtime.mjs';

const resultado = runProgram('print(tensor64(datos) @ tensor64(pesos))', {
  inputs: { datos: [[1, 2], [3, 4]], pesos: [2, 1] },
  seed: 42,
});
console.log(VERSION, resultado.records);
```

La API devuelve `{records, globals, steps}`. Las entradas se definen como
constantes; admiten valores JSON escalares y listas. Consulta la referencia para
reducir los presupuestos con `stepLimit` y `operationLimit`.

## Relación con UNIDAD

Los siete archivos de `src/` se recuperaron sin cambios del commit registrado en
[provenance.json](provenance.json). UNIDAD conserva su copia empaquetada y sus
adaptadores Python. El desarrollo independiente del lenguaje continúa aquí.

La [guía de integración](docs/unidad.md) explica los dos recorridos existentes:
inferencia del char-RNN y selección de tokens del Transformer. El cálculo del
Transformer permanece en PyTorch.

Para verificar los archivos recuperados y, opcionalmente, compararlos con una
copia local de UNIDAD:

```sh
npm run verify:origin
npm run verify:origin -- ../unidad
```

El manifiesto registra la extracción inicial. La comprobación informa diferencias
y termina con código 1 si se modificó esa base; no copia ni sobrescribe archivos.
Las ampliaciones futuras del motor deben conservar esta procedencia histórica y
validar su compatibilidad por comportamiento.

## Desarrollo

```sh
npm test
```

Las pruebas usan `node:test`, ejecutan programas y procesos reales y comprueban
aprendizaje, gradientes, checkpoints, CLI, selección de tokens y límites. La CI
ejecuta las pruebas y los ejemplos en Node.js 18, 22 y 24.

Con esta base se pueden explorar nuevos modelos y ampliar el propio lenguaje.
Los siguientes avances candidatos son módulos `.nv` reutilizables, mejores
diagnósticos y optimizadores adicionales; cada capacidad necesita implementación
y verificación antes de figurar como disponible.
