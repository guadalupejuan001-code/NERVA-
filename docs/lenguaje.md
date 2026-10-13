# Referencia de NERVA 0.2.0

NERVA ejecuta programas `.nv` en CPU mediante un intérprete de Node.js 18 o
posterior. Esta referencia describe el comportamiento de
[`parser.mjs`](../src/parser.mjs), [`runtime.mjs`](../src/runtime.mjs) y
[`tensor.mjs`](../src/tensor.mjs).

## Un programa pequeño

```nv
nerva 0.2
# Cada instrucción termina con un salto de línea o un punto y coma.
const nombre = "Unidad"
let total = 0
for numero in range(4) {
    total = total + numero
}
print(nombre, total)
assert(total == 6)
```

El encabezado `nerva 0.2` es opcional. Si aparece, ésa es la versión admitida.
Los bloques usan `{ }`. Los comentarios empiezan con `#`. Dentro de paréntesis
y listas se pueden repartir las expresiones entre varias líneas.

Para comprobar sintaxis y ejecutar un archivo desde la raíz del repositorio:

```sh
node src/nerva.mjs check programa.nv
node src/nerva.mjs run programa.nv
node src/nerva.mjs run programa.nv --json --seed 42
```

`check` comprueba la sintaxis; la ejecución también comprueba nombres, valores,
dimensiones y límites. `--json` devuelve `{version, records, steps}`. Los errores
del CLI salen por stderr como JSON y producen un código de salida distinto de cero.

## Valores y declaraciones

Los valores disponibles son números finitos, cadenas, booleanos, `null`, listas,
tensores y funciones. Los números ordinarios usan la representación de JavaScript;
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
escalar. Para obtener su número se usa `value`.

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

De menor a mayor precedencia: `or`, `and`, comparaciones, `+ -`, `* / @`,
signos y `not`, `^`, llamadas e índices. La potencia asocia hacia la derecha:
`2 ^ 3 ^ 2` equivale a `2 ^ (3 ^ 2)`. Usa paréntesis para expresar otra agrupación.

Las condiciones deben ser booleanas: `if cantidad > 0` es válido. Para comparar
un tensor escalar, convierte primero con `value`. La igualdad no compara listas
ni tensores.

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
| `len(x)` | Cuenta una lista, una cadena o la primera dimensión de un tensor. |
| `abs(x)`, `min(a, b)`, `max(a, b)` | Funciones numéricas escalares. |
| `sqrt(x)` | Raíz cuadrada de un número o tensor. |
| `print(valores...)` | Emite un registro de salida con los valores serializados. |
| `assert(condicion, mensaje)` | Exige una condición booleana verdadera; el mensaje es opcional. |

Los cálculos exigen resultados finitos. Por ejemplo, un desbordamiento, una
división por cero o un logaritmo fuera de su dominio producen un error.

## Diferenciación y actualización de parámetros

```nv
nerva 0.2
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
devuelve su gradiente como tensor `f64` después de `backward`.

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

```js
import { runProgram, VERSION } from './src/runtime.mjs';
import { parse } from './src/parser.mjs';

const source = 'nerva 0.2\nprint(entrada + 1)';
parse(source);
const result = runProgram(source, {
  inputs: { entrada: 41 },
  seed: 42,
  stepLimit: 200_000,
  operationLimit: 20_000_000,
});
console.log(VERSION, result.records[0].values); // 0.2.0 [42]
```

Los imports del ejemplo se resuelven desde un módulo situado en la raíz del
repositorio. `parse(source)` devuelve el AST y `lex(source)` devuelve tokens.
Ambas funciones y `LangError` se exportan desde `parser.mjs`.

`runProgram` ejecuta de forma síncrona y devuelve `{records, globals, steps}`.
`records` contiene las salidas de `print` y `checkpoint`; `globals` contiene los
valores globales serializados, omitiendo funciones globales; `steps` cuenta los
pasos del intérprete. Los tensores se serializan como
`{type: "tensor", shape, dtype, data}`. `runSource2(source, opciones)` devuelve
sólo `records`. `VERSION` vale `"0.2.0"`; la versión de cada registro vale `"0.2"`.

`inputs` es un objeto del anfitrión cuyas claves crean constantes globales.
Los valores admitidos son números finitos, cadenas, booleanos, `null` y listas
anidadas de esos valores. Los nombres siguen las reglas de los identificadores
y no pueden reemplazar funciones incorporadas. El programa tampoco puede
redeclarar una entrada en su ámbito global.

`seed`, `stepLimit` y `operationLimit` son opcionales; sus valores predeterminados
son 42, 200.000 y 20.000.000. Los presupuestos se pueden reducir. Los fallos del
parser y del intérprete se comunican como `LangError`, con línea y columna.

El módulo `tensor.mjs` exporta `Tensor` y sus operaciones para uso directo desde
JavaScript. Su presupuesto de operaciones es compartido por ese módulo y se
reinicia al entrar en `runProgram`; la API de programas está diseñada para
ejecuciones síncronas. El CLI y el trabajador de conversación ejecutan programas
de manera secuencial.

## Límites de ejecución

| Recurso | Límite de 0.2.0 |
| --- | ---: |
| Fuente | 200.000 caracteres |
| Tokens y nodos del AST | 100.000 de cada uno |
| Profundidad de parseo/AST, funciones, entrada y salida | 64 |
| Argumentos de funciones y llamadas | 32 |
| Pasos del intérprete | 200.000; configurable entre 1 y ese máximo |
| Presupuesto tensorial | 20.000.000 operaciones contabilizadas; configurable entre 1 y ese máximo |
| Tensor | 1.000.000 elementos, rango máximo 8 |
| Tamaño de cada dimensión | De 0 a 1.000.000, respetando el límite total |
| `range`, bucles y listas recibidas del anfitrión | 100.000 elementos o iteraciones |
| Registros de salida | 1.000 |
| Salida acumulada y presupuesto de serialización | 10.000.000 caracteres por presupuesto |
| Valores y contenedores serializados | 1.000.000 |
| Entrada del anfitrión | 1.000.000 valores y contenedores; cadenas de hasta 200.000 caracteres cada una y 10.000.000 en conjunto |
| Concatenación de cadenas | 200.000 caracteres por resultado |

Los límites se acumulan dentro de una ejecución y pueden alcanzarse durante la
serialización del resultado, además de durante los cálculos. El presupuesto
tensorial cuenta trabajo según cada operación; no es una medida de tiempo de CPU.
La API síncrona no impone un tiempo máximo de pared. Un anfitrión que necesite
ese límite puede ejecutar el intérprete en un proceso con timeout.
