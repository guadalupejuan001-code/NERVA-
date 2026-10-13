# Referencia de NERVA 0.3.0

NERVA ejecuta programas y proyectos `.nv` en CPU mediante un intérprete de
Node.js 18 o posterior para el CLI, sin dependencias npm. El runtime
`runtime.mjs` también se importa directamente en navegadores como módulo ES;
parser, tensores y resolución léxica de módulos no requieren APIs Node.
`project.mjs` y el CLI conservan sus operaciones de archivos en Node. Esta referencia describe
[`parser.mjs`](../src/parser.mjs), [`runtime.mjs`](../src/runtime.mjs),
[`tensor.mjs`](../src/tensor.mjs), [`project.mjs`](../src/project.mjs) y
[`cli.mjs`](../src/cli.mjs): módulos, datos estructurados, funciones del
anfitrión y cálculo diferenciable.

## Un programa pequeño

```nv
nerva 0.3
# Cada instrucción termina con un salto de línea o un punto y coma.
const nombre = "Unidad"
let total = 0
for numero in range(4) {
    total = total + numero
}
print(nombre, total)
assert(total == 6)
```

Se admiten los encabezados `nerva 0.2` y `nerva 0.3`; omitirlo conserva la
versión de registros `"0.2"`. El encabezado identifica esa versión de salida,
no limita la sintaxis a un subconjunto anterior. Los bloques usan `{ }` y los
comentarios empiezan con `#`. Dentro de paréntesis, listas y registros se
pueden repartir las expresiones entre varias líneas.

Para comprobar sintaxis y ejecutar un archivo desde la raíz del repositorio:

```sh
node src/nerva.mjs check programa.nv
node src/nerva.mjs run programa.nv
node src/nerva.mjs run programa.nv --json --seed 42
```

`check` carga las dependencias y comprueba sintaxis, rutas, ciclos y nombres
importados; no ejecuta el programa ni comprueba todos sus tipos o nombres.
`run --json` conserva `{version, records, steps}`; `--profile` añade
`tensorOperations` y `--globals` añade los valores globales serializados.
Los errores del CLI
salen por stderr como JSON con `error`, `file`, `line` y `column`, y producen
un código de salida distinto de cero.

## Proyectos y comandos

Desde la raíz del repositorio:

```sh
node src/nerva.mjs init private/mi-proyecto
node src/nerva.mjs check private/mi-proyecto
node src/nerva.mjs run private/mi-proyecto --json
node src/nerva.mjs test private/mi-proyecto --json
node src/nerva.mjs build private/mi-proyecto --out private/mi-proyecto.nvb
node src/nerva.mjs run private/mi-proyecto.nvb --json
```

`init` crea `main.nv`, un módulo en `lib/`, una prueba en `tests/` y
`nerva.json`. El destino debe estar vacío. Un manifiesto básico es:

```json
{
  "name": "mi-proyecto",
  "version": "0.1.0",
  "entry": "main.nv",
  "tests": "tests"
}
```

`run`, `check` y `build` aceptan un archivo o una carpeta con ese manifiesto.
`entry` se omite con valor predeterminado `main.nv`; `tests` se omite con
valor `tests`. `name` y `version` son metadatos del proyecto, sin resolución
de paquetes. Las rutas del manifiesto deben permanecer dentro de la carpeta.

`test` ejecuta archivos `*.test.nv` secuencialmente con estado nuevo por
archivo. Acepta un archivo, una carpeta o, sin argumento, la carpeta actual.
Busca recursivamente, omitiendo nombres que empiezan por punto,
`node_modules/` y `private/` dentro del árbol. Una prueba pasa si termina
sin error; `assert` permite expresar sus comprobaciones. Si alguna falla,
el proceso termina con código 1 y el informe JSON contiene
`{version, passed, failed, tests}`.

`--root carpeta` fija la raíz desde la que se resuelven los módulos y tiene
prioridad sobre la detección automática. Para archivos y carpetas de pruebas
se busca el `nerva.json` más cercano en las carpetas ascendentes; si existe,
su carpeta sirve de raíz. Sin manifiesto, se utiliza la carpeta del archivo
o la carpeta de pruebas. Por ejemplo, una prueba que importa
`../lib/util.nv` necesita una raíz que incluya `tests/` y `lib/`.

`build` crea un `.nvb`: un documento JSON con `format: "nerva-bundle"`,
`version: 1`, `languageVersion: "0.3.0"`, `entry`, `sources` y
`hashes`. Contiene una copia de las fuentes y SHA-256 por módulo. Se ejecuta
con el mismo intérprete, sin leer las fuentes originales. **Es un snapshot
de fuentes, no compilación a código máquina, WebAssembly o GPU.** Al cargarlo
se comprueban formato, versión del runtime, rutas y hashes.
Las entradas JSON, checkpoints y módulos JavaScript del anfitrión se
suministran por separado; el bundle contiene las fuentes `.nv`.

`run` admite `--inputs datos.json`, `--seed N`, `--steps N`,
`--operations N`, `--max-list N` y `--max-loops N`.
`test` admite los mismos controles numéricos. `--host funciones.mjs`
está disponible en ambos. `run --out carpeta` guarda los checkpoints
emitidos como `nombre.json`; `build --out archivo.nvb` exige un destino.
`--json` está disponible en `run`, `build`, `test` e `init`.

El [ejemplo de facturación modular](../examples/professional/README.md)
combina imports, validación, cantidades enteras, JSON y pruebas:

```sh
node src/nerva.mjs run examples/professional/main.nv --inputs examples/professional/input.json --json
node src/nerva.mjs test examples/professional --json
```

Es un ejemplo ejecutable con datos sintéticos y reglas de cálculo explícitas,
no una certificación fiscal ni de preparación para producción.

## Valores y declaraciones

Los valores disponibles son números finitos, cadenas, booleanos, `null`, listas,
registros, tensores y funciones. Los números ordinarios usan la representación de JavaScript;
las operaciones que necesitan enteros exigen enteros seguros. Se aceptan literales
decimales y exponentes, como `0.5` y `1e-3`.

Las cadenas admiten comillas simples o dobles y escapes como `\n`, `\t`, `\\`
y `\u00f1`. Los identificadores usan letras ASCII, números y `_`, y comienzan
con una letra o `_`.

| Declaración | Comportamiento |
| --- | --- |
| `let x = 1` | Permite reasignar `x` con `x = 2`. |
| `const x = 1` | Mantiene fijo el vínculo entre el nombre y el valor. |
| `param w = tensor([1, 2])` | Crea una copia del tensor como parámetro hoja diferenciable; su nombre es constante y sus datos se actualizan mediante `step` o `restore`. |
| `const x: Tensor[2, 3] = ...` | Comprueba la forma al declarar el tensor. También se admite con `let` y `param`. |

La anotación `Tensor[...]` comprueba dimensiones, no define un sistema de tipos
estático ni comprueba futuras reasignaciones de un `let`. `Tensor[]` indica un
tensor escalar. Los nombres declarados dentro de bloques son locales a esos bloques;
una reasignación puede alcanzar un `let` del ámbito exterior.

Listas, cadenas y tensores admiten `valor[indice]` con índices desde cero. En
cadenas el índice cuenta puntos de código Unicode. En tensores selecciona la
primera dimensión y devuelve otro tensor; una selección de un vector es un tensor
escalar. Para obtener su número se usa `value`. Los registros admiten
`registro.clave` y `registro["clave"]`. Un acceso directo a una clave o
índice inexistente produce un error; `get` permite indicar un valor alternativo.

Las claves de un literal de registro son identificadores, palabras clave o
cadenas; son cadenas en todos los casos y no pueden repetirse:

```nv
nerva 0.3
const original = {nombre: "Nerva", "tipo de proyecto": "datos", intentos: 0}
const actualizado = set(original, "intentos", 1)
assert(original.intentos == 0)
assert(actualizado["intentos"] == 1)
assert(get(actualizado, "ausente", 7) == 7)
print(keys(actualizado))
```

`set`, `append`, `concat` y `sort` devuelven colecciones nuevas; no
modifican la colección original. Las copias conservan los valores contenidos:
un tensor diferenciable dentro de una lista o registro conserva su identidad.
La asignación se aplica a nombres `let`, no a `lista[i]` o `registro.clave`.

```nv
const datos = ["a", "b", "c"]
const vector = tensor64([3, 7])
print(datos[1], value(vector[0]), len("🧠a"))
assert(value(vector[1]) == 7)
```

## Operadores

| Operadores | Uso |
| --- | --- |
| `+`, `-`, `*`, `/`, `^` | Aritmética numérica y operaciones elemento a elemento en tensores. `^` es potencia. |
| `@` | Producto de vectores y matrices. |
| `+` entre cadenas | Concatenación. |
| `==`, `!=` | Igualdad de valores escalares, incluidas cadenas, booleanos y `null`. |
| `<`, `<=`, `>`, `>=` | Comparación de números. |
| `not`, `and`, `or` | Lógica booleana; `and` y `or` evalúan su segundo operando sólo cuando hace falta. |
| `+x`, `-x` | Signo de un número o tensor. |
| `%` | Resto numérico escalar con el signo del dividendo, según JavaScript; divisor distinto de cero. |

De menor a mayor precedencia: `or`, `and`, comparaciones, `+ -`, `* / % @`,
signos y `not`, `^`, llamadas, índices y miembros. La potencia asocia hacia la derecha:
`2 ^ 3 ^ 2` equivale a `2 ^ (3 ^ 2)`. Usa paréntesis para expresar otra agrupación.

Las condiciones deben ser booleanas: `if cantidad > 0` es válido. Para comparar
un tensor escalar, convierte primero con `value`. La igualdad no compara listas
ni tensores ni registros.

## Funciones y control de flujo

```nv
fn doble(numero) {
    return numero * 2
}

let resultado = 0
for numero in range(1, 5) {
    if numero == 2 {
        continue
    }
    resultado = resultado + doble(numero)
}
while resultado < 20 {
    resultado = resultado + 1
}
if resultado == 20 {
    print("completo")
} else {
    print("pendiente")
}
assert(resultado == 20)
```

`fn nombre(argumentos) { ... }` declara una función en su ámbito. Los argumentos
son locales y se pueden reasignar. `return` termina la función; una función sin
retorno explícito devuelve `null`. `return` se permite dentro de funciones y
`break`/`continue` dentro de bucles. Se admite `else if`.

`for x in lista` recorre una lista. `range(fin)`, `range(inicio, fin)` y
`range(inicio, fin, paso)` generan listas de enteros y excluyen `fin`; el paso
puede ser negativo y debe ser distinto de cero.

Las funciones son valores: se pueden guardar en variables, pasar como argumentos
y devolver desde otras funciones. Conservan su ámbito léxico. Se declaran con
`fn`; no hay sintaxis de funciones anónimas.

```nv
nerva 0.3
fn doble(x) { return x * 2 }
fn par(x) { return x % 2 == 0 }
fn sumar(a, b) { return a + b }
fn comparar(a, b) { return a - b }
const numeros = [3, 1, 2]
const ordenados = sort(numeros, comparar)
assert(ordenados[0] == 1)
assert(numeros[0] == 3)
assert(reduce(map(filter(numeros, par), doble), sumar, 0) == 4)
```

## Módulos

Un módulo puede exportar declaraciones globales `fn`, `let`, `const` y
`param`. Las importaciones y exportaciones se permiten sólo fuera de bloques.
Ejemplo de `lib/calculo.nv`:

```nv
nerva 0.3
export let llamadas = 0
export fn doble(x) {
    llamadas = llamadas + 1
    return x * 2
}
```

En `main.nv`:

```nv
nerva 0.3
import { doble as multiplicar, llamadas } from "./lib/calculo.nv"
import * as calculo from "./lib/calculo.nv"
assert(multiplicar(3) == 6)
assert(llamadas == 1)
assert(calculo.llamadas == 1)
print(calculo.doble(4))
```

Los nombres importados son referencias de sólo lectura al vínculo exportado.
Si el módulo reasigna su `export let`, las importaciones individuales y el
espacio de nombres ven el nuevo valor. Un módulo se inicializa una sola vez
por ejecución, en el momento de su primera importación; sus instrucciones
globales también se ejecutan.

Las rutas son relativas, con `./` o `../`. El cargador de proyectos exige
archivos `.nv` dentro de la raíz, también después de resolver enlaces
simbólicos. Rechaza ciclos y nombres que el módulo no exporta. Cada módulo
posee su propio ámbito global y comparte las funciones incorporadas y el
`host` registrado. Las entradas de `inputs` pertenecen al programa raíz:
pasa los datos a funciones importadas mediante argumentos.

## Colecciones, texto y JSON

| Función | Comportamiento |
| --- | --- |
| `append(lista, valor)` | Devuelve una lista con un elemento más. |
| `concat(a, b)` | Concatena dos listas. |
| `slice(lista_o_texto, inicio, fin)` | Copia el intervalo; `fin` es opcional y excluido. Exige `0 <= inicio <= fin <= longitud`. Los índices de texto cuentan puntos de código. |
| `get(objeto, clave, alternativa)` | Lee un registro, lista o cadena; devuelve `alternativa`, o `null` si se omite, cuando no existe la clave o índice. |
| `has(objeto, clave)` | Comprueba la existencia de una clave de registro o índice de lista/cadena. |
| `set(objeto, clave, valor)` | Copia un registro añadiendo/sustituyendo una clave, o una lista sustituyendo un índice existente. |
| `keys(registro)`, `values(registro)` | Devuelven listas en el orden de inserción de las claves. |
| `map(lista, fn)` | Llama a `fn(valor)` por elemento. |
| `filter(lista, fn)` | Conserva valores para los que `fn(valor)` devuelve `true`; exige booleanos. |
| `reduce(lista, fn, inicial)` | Acumula con `fn(acumulador, valor)`; una lista vacía devuelve `inicial`. |
| `sort(lista, fn)` | Copia y ordena con un comparador numérico `fn(a, b)`: negativo, cero o positivo. |
| `split(texto, separador)` | Divide con un separador literal; no acepta expresiones regulares. |
| `join(lista, separador)` | Une cadenas; el separador es opcional y vale `""`. |
| `trim(texto)`, `lower(texto)`, `upper(texto)` | Recorta espacios o cambia mayúsculas/minúsculas con las reglas de JavaScript. |
| `replace(texto, buscar, reemplazo)` | Sustituye todas las coincidencias literales. El reemplazo se inserta literalmente. |
| `contains(texto_o_lista, valor)` | Busca una subcadena o un valor escalar de una lista. |
| `str(valor)` | Convierte escalares a texto y serializa listas, registros o tensores como JSON. |
| `number(valor)` | Acepta un número finito o una cadena numérica no vacía; usa conversión numérica de JavaScript. |
| `json_parse(texto)` | Convierte JSON a valores del lenguaje, incluidos registros. |
| `json_stringify(valor)` | Serializa los valores admitidos por `print` como JSON. |
| `round(x)`, `floor(x)`, `ceil(x)` | Redondeo numérico escalar según JavaScript. |

`split(texto, "")` sigue las unidades UTF-16 de JavaScript. Para recorrer
puntos de código Unicode utiliza índices, `slice` y `len`.

```nv
nerva 0.3
const pedido = json_parse('{"cliente":" Ana ","cantidades":[2,3]}')
fn sumar(a, b) { return a + b }
const salida = {
    cliente: upper(trim(pedido.cliente)),
    unidades: reduce(pedido.cantidades, sumar, 0)
}
assert(salida.cliente == "ANA")
assert(salida.unidades == 5)
assert(replace("a-a", "a", "$") == "$-$")
print(json_stringify(salida))
```

## Tensores y funciones incorporadas

Los tensores conservan una forma y un tipo numérico: `f32` o `f64`. Los datos
anidados deben ser rectangulares. `tensor` produce `f32`; `tensor64` produce
`f64`. Las operaciones entre dos tensores promueven el resultado a `f64` si alguno
usa ese tipo. Un número combinado con un tensor se convierte al tipo del tensor.

```nv
const matriz: Tensor[2, 2] = tensor64([[1, 2], [3, 4]])
const vector = tensor64([2, 1])
const producto = matriz @ vector
print(shape(producto), producto)
assert(value(producto[0]) == 4)
assert(value(producto[1]) == 10)
```

La aritmética elemento a elemento admite broadcasting: las dimensiones se
alinean desde la derecha y deben coincidir o tener tamaño uno. `@` admite
vector-vector, matriz-vector, vector-matriz y matriz-matriz, con dimensiones
internas compatibles. El producto de dos vectores devuelve un tensor escalar.

| Función | Comportamiento |
| --- | --- |
| `tensor(datos)`, `tensor64(datos)` | Construye o copia un tensor. |
| `zeros(forma, tipo)`, `ones(forma, tipo)` | Inicializa un tensor; `tipo` es opcional y vale `"f32"` por defecto. |
| `randn(forma, escala)` | Inicializa un tensor `f32` con muestras normales; la escala es opcional y vale 1. |
| `seed(entero)` | Reinicia el generador local con una semilla de 0 a 4.294.967.295. |
| `shape(t)` | Devuelve una lista con las dimensiones. |
| `reshape(t, forma)` | Cambia la forma conservando el número de elementos; las dimensiones son explícitas. |
| `transpose(t)` | Transpone una matriz de dos dimensiones. |
| `relu(t)`, `tanh(t)`, `sigmoid(t)`, `exp(t)`, `log(t)` | Aplica una función a cada elemento. |
| `sum(t)`, `mean(t)` | Reduce todos los elementos a un tensor escalar. La media exige elementos. |
| `softmax(t)` | Normaliza sobre la última dimensión, que debe ser no vacía. |
| `mse(prediccion, objetivo)` | Calcula la media del error cuadrático; admite broadcasting compatible. |
| `cross_entropy(logits, etiquetas)` | Admite logits `[clases]` o `[lote, clases]`; las etiquetas son una lista o vector no diferenciable de índices, uno por fila. Devuelve la pérdida media. |
| `argmax(t)` | Devuelve el índice plano del primer máximo; exige un tensor no vacío. |
| `detach(t)` | Copia el tensor y lo separa del grafo de gradientes. |
| `value(t)` | Convierte un tensor escalar a número; también acepta un número. |
| `len(x)` | Cuenta una lista, claves de un registro, puntos de código de una cadena o la primera dimensión de un tensor. |
| `abs(x)`, `min(a, b)`, `max(a, b)` | Funciones numéricas escalares. |
| `sqrt(x)` | Raíz cuadrada de un número o tensor. |
| `print(valores...)` | Emite un registro de salida con los valores serializados. |
| `assert(condicion, mensaje)` | Exige una condición booleana verdadera; el mensaje es opcional. |

Los cálculos exigen resultados finitos. Por ejemplo, un desbordamiento, una
división por cero o un logaritmo fuera de su dominio producen un error.

## Diferenciación y actualización de parámetros

```nv
nerva 0.3
param peso = tensor64(0)
const objetivo = tensor64(3)
for iteracion in range(20) {
    zero_grad([peso])
    const perdida = mse(peso, objetivo)
    backward(perdida)
    step([peso], 0.1)
}
print("peso", peso, "perdida", value(mse(peso, objetivo)))
assert(value(mse(peso, objetivo)) < 0.01)
```

`backward(perdida)` calcula gradientes por diferenciación inversa. La pérdida
debe ser un tensor escalar conectado a parámetros diferenciables. `grad(p)`
devuelve una copia de su gradiente como tensor `f64` después de `backward`,
separada del grafo: no proporciona derivadas de orden superior.

`zero_grad(parametros)` borra los gradientes. Las llamadas sucesivas a
`backward` acumulan gradientes en los parámetros hoja hasta que se borran.
`step(parametros, tasa)` aplica descenso de gradiente:
`parametro = parametro - tasa * gradiente`, con una tasa finita y positiva.
No borra los gradientes. Estas funciones aceptan un parámetro o una lista de
entre 1 y 32 parámetros hoja distintos.

Cada iteración debe volver a calcular la pérdida después de actualizar pesos.
El grafo detecta parámetros modificados mediante `step` o `restore` desde el
cálculo de una pérdida anterior. Gradientes y actualizaciones se validan antes
de incorporarse a los parámetros.

## Checkpoints

```nv
param pesos = tensor64([1, 2])
const guardado = checkpoint("inicial", [pesos])
zero_grad([pesos])
backward(sum(pesos))
step([pesos], 0.1)
restore(guardado, [pesos])
assert(value(pesos[0]) == 1)
assert(value(pesos[1]) == 2)
```

`checkpoint(nombre, parametros)` emite un registro y devuelve una cadena JSON.
El nombre admite de 1 a 64 letras ASCII, números, `_` o `-`. El contenido tiene
`format: "nerva-checkpoint"`, `version: 1` y una lista `tensors` con forma, tipo
y datos, en el orden recibido. Guarda valores de parámetros; no conserva el
programa, los gradientes ni el estado del generador aleatorio.

`restore(texto, parametros)` exige el mismo número, orden, formas y tipos.
Comprueba todo el contenido antes de modificar parámetros y borra sus
gradientes al restaurar.

Para guardar los registros emitidos como archivos `nombre.json`:

```sh
node src/nerva.mjs run programa.nv --out private/checkpoints
```

El anfitrión puede leer ese archivo y pasar su texto como una entrada constante
mediante `--inputs datos.json` o la API de JavaScript.

## Selección de tokens

```nv
const logits = tensor64([9, 3, 3, 2])
const token = select_token(logits, [0], [], 0, 0, 1, 1, 0)
assert(token == 1)
```

La firma es
`select_token(logits, excluidos, generados, temperatura, top_k, top_p, penalizacion, sorteo)`.
Recibe un vector de logits y devuelve un índice. Temperatura cero elige el primer
máximo permitido. Con temperatura positiva usa `sorteo` como muestra uniforme
entre 0 incluido y 1 excluido, aplica top-k y después top-p; top-p conserva el
token que alcanza o supera el umbral acumulado. La penalización se aplica una
sola vez a cada índice presente en `generados`: divide las puntuaciones positivas
y multiplica las negativas.

Se admiten temperatura de 0 a 2, top-k entero de 0 a 65.536, top-p de 0,000001
a 1 y penalización de 1 a 2. Los controles neutrales son top-k 0, top-p 1 y
penalización 1. El vector contiene de 1 a 65.536 logits; cada lista de índices
contiene como máximo 4.096 elementos válidos. Excluir todos los tokens produce
un error. El selector recibe puntuaciones ya calculadas; su resultado es un índice.

## API de JavaScript

Estos imports se resuelven desde un módulo en la raíz del repositorio:

```js
import { runProgram, prepareProgram, VERSION } from './src/runtime.mjs';
import { parse } from './src/parser.mjs';

const source = `
nerva 0.3
print(entrada + 1)
`;
parse(source);
const result = runProgram(source, {
  inputs: { entrada: 41 },
  seed: 42,
  stepLimit: 200_000,
  operationLimit: 20_000_000,
});
console.log(VERSION, result.records[0].values); // 0.3.0 [42]

const prepared = prepareProgram(source);
console.log(prepared.run({ inputs: { entrada: 9 } }).records[0].values); // [10]
```

`parse(source)` devuelve el AST y `lex(source)` devuelve tokens; ambas
funciones y `LangError` se exportan desde `parser.mjs`. Los errores del
runtime incluyen archivo y, cuando hay un nodo asociado, línea y columna.

`runProgram(source, opciones)` ejecuta de forma síncrona y devuelve
`{records, globals, steps, tensorOperations}`. `records` contiene las
salidas de `print` y `checkpoint`; `steps` cuenta pasos del intérprete y
`tensorOperations` el presupuesto tensorial consumido, incluida la
serialización. `runSource2(source, opciones)` devuelve sólo `records`.
`VERSION` vale `"0.3.0"`. Cada registro usa la versión del encabezado del
módulo que ejecutó `print` o `checkpoint`, o `"0.2"` si se omitió:
un proyecto puede producir registros de ambas versiones.

`globals` incluye los valores globales del programa raíz serializados;
omite las funciones globales. Las funciones contenidas dentro de registros
o listas globales se describen con `{type: "function", name}`; `print`
y las llamadas al anfitrión requieren valores serializables y no admiten
funciones. `captureGlobals: false` omite la captura y devuelve un objeto
global vacío; la API captura por defecto y el CLI sólo con `--globals`.

Los tensores se serializan como `{type: "tensor", shape, dtype, data}`.
Los registros se devuelven como objetos sin prototipo; siguen siendo
serializables con `JSON.stringify`. Para comprobar sus claves desde
JavaScript usa `Object.hasOwn` o `Object.keys`.

`inputs` es un objeto JSON cuyas claves crean constantes globales del
programa raíz. Admite números finitos, cadenas, booleanos, `null`, listas
y objetos planos, también con prototipo nulo. Los datos se copian y los
objetos se convierten en registros. No admite funciones, promesas, ciclos,
propiedades con getters/setters, símbolos ni listas dispersas. Los nombres siguen
las reglas de los identificadores; no pueden reemplazar funciones
incorporadas o `host` cuando está registrado, ni redeclararse globalmente.

`prepareProgram(source, {filename, modules})` analiza y resuelve las
dependencias una sola vez. `filename` identifica la fuente raíz y
`modules` es un objeto de nombres de archivo a fuentes de texto:

```js
import { prepareProgram } from './src/runtime.mjs';

const prepared = prepareProgram(`
nerva 0.3
import { doble } from "./lib/calculo.nv"
print(doble(entrada))
`, {
  filename: 'main.nv',
  modules: { 'lib/calculo.nv': 'nerva 0.3; export fn doble(x) { return x * 2 }' },
});
console.log(prepared.run({ inputs: { entrada: 6 } }).records[0].values); // [12]
```

La preparación utiliza las fuentes suministradas, sin leer archivos.
Cada `prepared.run(opciones)` crea ámbitos, parámetros, inicializaciones
de módulos, RNG y presupuesto nuevos: reutiliza el AST, no el estado de
una corrida anterior. `runProgram` también acepta `filename` y `modules`.

`project.mjs` añade operaciones de archivos mediante APIs de Node.js:

```js
import { loadProject, buildProject, loadBundle } from './src/project.mjs';

const project = await loadProject('examples/hola.nv');
console.log(project.prepared.run({ captureGlobals: false }).records[0].values);
const bundle = await buildProject('examples/hola.nv');
const loaded = loadBundle(bundle);
console.log(loaded.prepared.run({ captureGlobals: false }).records[0].values);
```

`loadProject(archivo, {root, maxModules, maxSourceBytes})` devuelve
`{root, entry, sources, prepared}`; `buildProject` devuelve el documento
`.nvb` y `loadBundle(documento, opciones)` devuelve
`{entry, sources, prepared}`. Los límites predeterminados del cargador
son 1.000 módulos y 10 MiB de fuentes UTF-8; ambos aceptan enteros seguros
positivos. `discoverTests(ruta)` y `initProject(destino)` también se
exportan desde ese módulo.

## Funciones del anfitrión

El anfitrión registra las funciones disponibles en `options.host`:

```js
import { runProgram } from './src/runtime.mjs';

const result = runProgram(`
nerva 0.3
const respuesta = host.saludar({nombre: "Ana"})
assert(respuesta.texto == "Hola, Ana")
print(respuesta)
`, {
  host: {
    saludar(persona) { return { texto: 'Hola, ' + persona.nombre }; },
  },
  captureGlobals: false,
});
console.log(JSON.stringify(result.records[0].values)); // [{"texto":"Hola, Ana"}]
```

`host` sólo existe si se registra. Cada propiedad debe ser una función
síncrona con un nombre válido. Recibe copias serializadas de los argumentos
y devuelve un valor JSON que se copia al lenguaje; devuelve `null` cuando
no necesita aportar datos. Los tensores llegan como su representación
JSON, no como instancias `Tensor`.

Una función `async`, un resultado `Promise`, un retorno `undefined` o
un valor ajeno a JSON producen un error. Los errores del anfitrión se
anotan con el nombre de la función y la ubicación de la llamada.
La ejecución es síncrona: las operaciones externas de esas funciones
no tienen timeout automático ni rollback si una instrucción posterior falla.

Para el CLI, un archivo `funciones.mjs` puede exportar:

```js
export default {
  saludar(persona) { return { texto: 'Hola, ' + persona.nombre }; },
};
```

Se registra con `node src/nerva.mjs run programa.nv --host funciones.mjs`.
También se admiten exportaciones nombradas cuando todas son funciones.
El intérprete no incorpora directamente acceso a archivos, red, Python,
C o bases de datos: un anfitrión puede implementar esas operaciones con
funciones registradas y el contrato síncrono descrito.

## Presupuestos y límites

`seed`, `stepLimit`, `operationLimit`, `collectionLimit` y `loopLimit`
son opcionales. Sus valores predeterminados son 42, 200.000, 20.000.000,
100.000 y 100.000. La semilla debe estar entre 0 y 4.294.967.295;
los cuatro presupuestos aceptan enteros seguros positivos, también
mayores que los predeterminados. Esto permite ampliar una corrida
concreta y mantiene límites explícitos.

Cada ejecución posee un presupuesto tensorial aislado. Las llamadas
anidadas a `runProgram`, incluidas las realizadas desde el anfitrión,
usan su contexto y restauran el de la ejecución exterior al terminar.
`tensorOperations` es la medida de la corrida; `T.getBudget()` fuera
de ella describe el contexto tensorial exterior.

Para usar `tensor.mjs` directamente:

```js
import * as T from './src/tensor.mjs';

const budget = T.createBudget(1000);
const result = T.withBudget(budget, () => T.add(T.tensor([1, 2]), 1));
console.log(T.serialize(result).data); // [2, 3]
console.log(T.getBudget(budget).used > 0); // true
```

`withBudget(contexto, fn)` exige trabajo síncrono y restaura el contexto
previo incluso si falla. `resetBudget`/`setBudget` reinician el contexto
activo para el uso tensorial directo.

| Recurso | Límite de 0.3.0 |
| --- | ---: |
| Fuente | 200.000 caracteres por módulo |
| Tokens y nodos del AST | 100.000 de cada uno por módulo |
| Profundidad de parseo/AST, funciones, entrada y salida | 64 |
| Argumentos de funciones y llamadas | 32 |
| Pasos del intérprete | 200.000 por defecto; `stepLimit` configurable |
| Presupuesto tensorial | 20.000.000 por defecto; `operationLimit` configurable |
| Tensor | 1.000.000 elementos, rango máximo 8 |
| Tamaño de cada dimensión | De 0 a 1.000.000, respetando el límite total |
| Listas, registros y `range` | 100.000 entradas por defecto; `collectionLimit` configurable |
| Iteraciones de cada bucle | 100.000 por defecto; `loopLimit` configurable |
| Registros de salida | 1.000 |
| Salida acumulada y presupuesto de serialización | 10.000.000 caracteres por presupuesto |
| Valores y contenedores serializados | 1.000.000 |
| Entrada y cada retorno JSON del anfitrión | 1.000.000 valores y contenedores, profundidad 64; cadenas y claves de hasta 200.000 caracteres y 10.000.000 en conjunto |
| Resultados de texto y texto de `json_parse` | 200.000 caracteres |
| Parámetros en llamadas de entrenamiento/checkpoint | Entre 1 y 32 hojas distintas |
| Proyecto o bundle mediante `project.mjs` | 1.000 módulos y 10 MiB de fuentes por defecto; configurables en la API |

Los límites se acumulan dentro de una ejecución y pueden alcanzarse durante la
serialización del resultado, además de durante los cálculos. El presupuesto
tensorial cuenta trabajo según cada operación; no es una medida de tiempo de CPU.
La API síncrona no impone un tiempo máximo de pared. Un anfitrión que necesite
ese límite puede ejecutar el intérprete en un proceso con timeout.

Ampliar pasos o operaciones no cambia los límites fijos de tensores,
parseo, profundidad y serialización. `collectionLimit` limita cada
colección, no acredita un límite de memoria total. No hay ejecución
asíncrona, entrenamiento distribuido ni backends nativos/GPU en esta versión.

## Migración desde 0.2

- Los programas con `nerva 0.2` o sin encabezado siguen emitiendo registros
  `version: "0.2"`; usar `nerva 0.3` produce `"0.3"`.
- `runProgram`, `runSource2`, `parse`, `lex` y los comandos `check`/`run`
  continúan disponibles. El resultado de `runProgram` añade
  `tensorOperations`; `run --json` sólo lo incluye con `--profile`.
  La versión del runtime es `"0.3.0"`.
- Los presupuestos mantienen sus valores predeterminados y ahora se pueden
  ampliar. Para imponer los mismos máximos de la integración anterior,
  el anfitrión debe conservar sus valores explícitos.
- La API sigue capturando globales por defecto; el CLI necesita `--globals`
  para incluirlos en JSON. Los registros serializados y el objeto
  `globals` usan objetos sin prototipo.
- `import`, `export`, `from` y `as` son palabras contextuales:
  identificadores anteriores con esos nombres siguen siendo válidos fuera
  de las formas de declaración de módulos.
- El esquema `nerva-checkpoint` versión 1 conserva su contrato de pesos;
  no se convirtió en un checkpoint completo de entrenamiento.
- El presupuesto tensorial ya no se reinicia globalmente al ejecutar un
  programa. Para medir una corrida usa `result.tensorOperations`;
  usa `createBudget`/`withBudget` si operas con tensores desde JavaScript.

La integración empaquetada de UNIDAD mantiene su runtime 0.2 hasta una
actualización deliberada; consulta [la guía de integración](unidad.md).
