# NERVA

**NERVA 0.3.0** es un lenguaje privado con módulos, datos estructurados,
colecciones, herramientas de proyecto e interoperabilidad JavaScript. Conserva
los tensores, autodiferenciación y entrenamiento local de la versión anterior.

El motor ejecuta programas `.nv` y requiere **Node.js 18+**, sin dependencias npm.
La versión 0.3 permite construir proyectos de varios archivos, probarlos y
empaquetarlos para ejecutarlos desde un snapshot portable.

## Empezar

Desde la raíz del repositorio, sin instalar paquetes:

```sh
node src/nerva.mjs --version
npm run demo:professional
npm run test:professional
npm test
```

El [ejemplo de facturación](examples/professional/README.md) recibe JSON, valida
pedidos, aplica descuentos e impuestos en centavos y produce un reporte. Sus
módulos y pruebas están escritos en NERVA; el lote sintético suma 51993 centavos.

## Crear y trabajar con un proyecto

```sh
node src/nerva.mjs init private/mi-app
node src/nerva.mjs check private/mi-app
node src/nerva.mjs run private/mi-app
node src/nerva.mjs test private/mi-app --json
node src/nerva.mjs build private/mi-app --out private/mi-app.nvb
node src/nerva.mjs run private/mi-app.nvb
```

`init` crea `nerva.json`, una entrada, un módulo y una prueba; no sobrescribe
archivos existentes. El manifiesto selecciona `entry` y `tests`. El CLI reconoce
la raíz del proyecto por `nerva.json`; `--root` permite elegirla explícitamente.

`check` comprueba la entrada y sus dependencias sin ejecutar sus efectos. `test`
ejecuta cada archivo `*.test.nv` con un estado nuevo y devuelve código 1 si alguno
falla. Los errores incluyen archivo, línea y columna cuando están disponibles.

`build` guarda las fuentes del grafo de módulos y sus hashes SHA-256 en un `.nvb`.
El paquete puede ejecutarse sin los archivos originales y valida sus hashes antes
de preparar el programa. Es un snapshot de fuentes, no código máquina nativo.

## Programar con módulos y datos

En `lib/prices.nv`:

```nv
nerva 0.3
export fn line_total(item) {
    return item.quantity * item.price_cents
}
```

En `main.nv`:

```nv
nerva 0.3
import { line_total } from "./lib/prices.nv"
const item = {sku: "DEMO", quantity: 2, price_cents: 1500}
const report = {sku: item.sku, total_cents: line_total(item)}
print(report)
```

Las importaciones pueden usar alias o namespaces. Los registros admiten acceso
por campo y clave; listas y registros tienen actualizaciones persistentes que
conservan los valores anteriores. `map`, `filter`, `reduce` y `sort` aceptan
funciones; también hay utilidades de cadenas, conversión y JSON.

Consulta la [referencia completa](docs/lenguaje.md) para las firmas, semántica,
versiones y presupuestos. Los programas anteriores con encabezado `nerva 0.2`
siguen admitidos; ese encabezado conserva la versión de sus registros de salida.

## Preparar una vez y reutilizar

```js
import { prepareProgram } from './src/runtime.mjs';

const program = prepareProgram('print(order.quantity * order.price_cents)');
const result = program.run({
  inputs: { order: { quantity: 2, price_cents: 1500 } },
  captureGlobals: false,
});
console.log(result.records[0].values); // [3000]
```

`prepareProgram` conserva el análisis del programa; cada `run` crea su propio
estado, módulos, parámetros y generador aleatorio. `runProgram` mantiene la API
anterior. La API captura los globales por defecto; el CLI los omite salvo
`--globals`. `--profile` añade el recuento tensorial al JSON del CLI.

Los presupuestos de pasos, operaciones, colecciones y bucles se configuran por
ejecución; aceptan enteros seguros positivos. Los contextos tensoriales se
restauran incluso cuando una función del anfitrión ejecuta otro programa.

## Conectar bibliotecas JavaScript

La API acepta un objeto de funciones síncronas registrado explícitamente por
el anfitrión:

```js
const program = prepareProgram('print(host.label(order))');
const result = program.run({
  inputs: { order: { id: 'DEMO-001' } },
  host: { label: order => 'Pedido ' + order.id },
});
```

El CLI permite `--host funciones.mjs`, con un export default que contiene esas
funciones. NERVA transfiere argumentos y resultados JSON mediante copias y
validación. Las funciones asíncronas y Promises se rechazan. Los efectos de una
función registrada pertenecen al anfitrión; un fallo no los revierte.

## Aprendizaje y experimentos

```sh
npm run train:regression
npm run train:classification
npm run explore
```

Se conservan tensores f32/f64, autograd, SGD, checkpoints y selección de tokens.
El laboratorio ejecuta aprendizaje, síntesis aritmética, planificación y
comparaciones de las API de ejecución. Guarda informes en
`experiments/results/0.3.0/`; los JSON anteriores de 0.2 se conservan en
`experiments/results/` como evidencia histórica.

Los experimentos de rendimiento distinguen preparación y omisión de globales.
La fusión tensorial continúa siendo un kernel manual de inferencia, con las
limitaciones descritas en su informe. Las mediciones corresponden a sus tareas
concretas y no acreditan rendimiento de una IA completa.

## Procedencia y UNIDAD

NERVA se desarrolla de forma independiente aquí. [provenance.json](provenance.json)
conserva los hashes de la extracción inicial de 0.2; el motor 0.3 contiene cambios
posteriores y nuevos archivos. Para inspeccionar las diferencias:

```sh
npm run verify:origin -- --report
```

La verificación estricta sin `--report` devuelve código 1 cuando hay diferencias
con esa base histórica. No se reescriben sus hashes. La copia 0.2 de UNIDAD
permanece separada; la [guía de integración](docs/unidad.md) describe cómo revisar
una actualización deliberada.

## Desarrollo

La CI ejecuta pruebas del motor y la aplicación de ejemplo en Node.js 18, 22 y 24.
El paquete está marcado como privado. Guarda datos personales, pesos y artefactos
propios en `private/` o en rutas excluidas de Git.
