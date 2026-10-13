# Renderer de primera persona

NERVA define una instalación industrial, sus materiales y luces, y ejecuta la
lógica de movimiento, inspección y conducta de Iria. El anfitrión conserva el
mundo, el jugador y la animación; WebGPU dibuja una escena rasterizada con
sombras, reflejo del suelo, iluminación PBR y antialiasing. El resultado es una
base de exploración en primera persona con un personaje animado original,
controles y colisiones, sin iluminación global calculada.

El entorno usa geometría y materiales procedimentales locales. El personaje
incluye un modelo glTF propio generado en Blender. No requiere modelos,
texturas ni paquetes de assets externos. Las técnicas se apoyan en
fuentes públicas enlazadas más abajo; las implementaciones citadas no son
dependencias del renderer.

Las siluetas del entorno proceden de cuatro primitivas instanciadas y el detalle
superficial de fórmulas en shader. Iria tiene malla y esqueleto propios. La
apariencia combina escala, contraste, reflejos y materiales, pero conserva las
limitaciones del entorno simplificado y del modelado procedural. No contiene
geometría fotogramétrica, texturas escaneadas ni assets de una producción AAA.

## Código y responsabilidades

| Componente | Código | Responsabilidad |
| --- | --- | --- |
| Escena NERVA | [scene.nv](../examples/fps/scene.nv) | Construye suelo, paneles, vigas, tuberías, depósitos, cajas, letreros, núcleo y luces. |
| Control NERVA | [control.nv](../examples/fps/control.nv) | Pasa entrada al controlador y decide inspección, patrulla, proximidad y diálogo del NPC. |
| Autor de escena | [author.mjs](../examples/fps/author.mjs) | Registra las funciones `host` de configuración, objetos, luces y letreros; valida el mundo resultante. |
| Mundo persistente | [world.mjs](../src/graphics/world.mjs) | Empaqueta instancias, luces, lotes por malla y AABB de colisión. |
| Cámara y movimiento | [camera.mjs](../src/graphics/camera.mjs) | Orientación yaw/pitch, gravedad, salto y deslizamiento contra obstáculos. |
| Modelo original | [iria.gltf](../assets/characters/iria.gltf) | Malla, materiales, esqueleto y clips Idle/Walk, con datos en [iria.bin](../assets/characters/iria.bin). |
| glTF y poses | [gltf.mjs](../src/graphics/gltf.mjs) | Parser portable, carga y muestreo de animación en arrays reutilizables. |
| Renderer | [fps-renderer.mjs](../src/graphics/fps-renderer.mjs) | Recursos residentes, grafo, pases opcionales, presentación, captura y métricas. |
| Shaders | [fps-shaders.mjs](../src/graphics/fps-shaders.mjs) | Materiales, PCF, reflejo, niebla, bloom, oclusión aproximada y salida. |
| Aplicación de exploración | [app.mjs](../examples/fps/app.mjs) | Entrada del navegador, pointer lock, bucle, misión, presentación y verificaciones. |

El programa `.nv` se ejecuta realmente en el intérprete; no es una traducción
estática a JavaScript. El autor prepara `scene.nv` y registra `host.configure`,
`host.object`, `host.light` y `host.sign`. Los letreros se generan con cajas
pequeñas a partir de glifos locales. `control.nv` recibe entrada y estado de
misión y llama a `host.move` y `host.status`.

Cada ejecución del intérprete sigue creando sus propios ámbitos. El controlador
y el estado de misión/NPC viven en el anfitrión y se pasan a la siguiente
ejecución.
El intercambio usa JSON de entrada y resultado; no transporta de nuevo todos
los buffers gráficos. La finalización GPU continúa fuera del contrato síncrono
de NERVA. Véase la [referencia del lenguaje](lenguaje.md).

## Cámara y colisiones

La cámara usa coordenadas con `+Z` hacia delante. Yaw positivo gira hacia `+X`;
pitch positivo mira hacia `+Y`. `cameraBasis` produce los vectores right, up y
forward en f32 para compartir la misma orientación entre referencia CPU y GPU.

El controlador recibe `{forward, strafe, sprint, lookDX, lookDY, jump}` y un
intervalo en segundos. La aplicación puede mapear WASD al movimiento, ratón a
mirar, Shift a sprint y Espacio al salto. Las diagonales se normalizan; mirar
arriba/abajo no cambia la dirección horizontal de marcha. La sensibilidad y
las velocidades se pueden configurar. La misión NERVA atiende la interacción
con E al acercarse a la zona de consola.

En la [demo](../examples/fps/index.html), «Entrar» captura el ratón mediante
pointer lock y activa esos controles. Esc, pérdida de captura o cambio de foco
pausan el movimiento y limpian las teclas retenidas. El programa NERVA de control
se ejecuta durante el bucle y conserva la misión a través del anfitrión.

El cuerpo de colisión es una **AABB conservadora**, con anchura de dos radios y
altura configurable: no es una cápsula física exacta. Las AABB de los obstáculos
incluyen la rotación yaw de sus objetos y pueden ser más grandes que la malla
visible, especialmente en cilindros y esferas. El movimiento se resuelve por
ejes, permite deslizarse por paredes y apoyar los pies sobre cajas. Usa subpasos
de tiempo y distancia y limita un intervalo a 250 ms.

`setDynamicColliders(colliders)` reemplaza bloqueadores cinemáticos sin modificar
los colliders estáticos del mundo; `dynamicColliderCount` informa su cantidad.
Valida todo el lote y rechaza cajas que ya se solapen con el jugador antes de
aplicar el cambio. La aplicación actualiza una AABB alrededor de la posición
actual de Iria después de la lógica NERVA, de modo que el jugador no atraviesa
su cuerpo. Esa caja conservadora no sigue cada articulación ni implementa
una cápsula, empujes o contacto de cuerpos rígidos.

Este controlador no resuelve cuerpos rígidos, pendientes o subida automática de
escalones. El salto se activa en el flanco del botón, evitando saltos repetidos
por mantenerlo pulsado. Su estado incluye posición, orientación, velocidad
vertical y contacto con suelo; `reset` valida que la posición no atraviese
obstáculos ni límites.

## Mundo residente

Esta ruta FPS tiene un layout distinto del
[prototipo de esferas con tres LOD](arquitectura-grafica.md): usa **64 bytes por
instancia**, intercalados en cuatro `vec4` f32.

| Grupo | Valores |
| --- | --- |
| `positionYaw` | Posición xyz y yaw. |
| `scaleKind` | Dimensiones completas xyz y tipo de malla. |
| `colorRoughness` | Color lineal rgb y rugosidad. |
| `materialParams` | Metalicidad, emisión, patrón y peso de reflejo. |

Hay cuatro mallas compartidas: caja, cilindro vertical, esfera y tubería
orientada en Z. Sus vértices tienen posición, normal y UV, 32 bytes por vértice;
los índices son u32. Los objetos se agrupan en hasta cuatro lotes y se dibujan
por instancing. Las normales consideran la escala no uniforme.

Las luces puntuales usan un buffer fijo de 512 bytes para hasta 16 luces con
posición, radio, color e intensidad. El mundo acepta como máximo 100.000
objetos; ese límite de validación no promete una frecuencia de cuadros. Los
arrays CPU, colliders y metadata se suman a sus copias GPU.

Geometría y luces se suben al inicializar. La ruta es estática: modificar arrays
CPU después no actualiza automáticamente recursos ni sombras. Para cambiar esa
estructura se debe reconstruir el mundo/renderer; la cámara y los parámetros de
efectos sí se actualizan por cuadro. No hay culling GPU, LOD, oclusión jerárquica
ni streaming en este renderer FPS. Los lotes reducen dibujos, pero no descartan
individualmente objetos fuera de pantalla.

La instalación actual contiene **446 objetos estáticos, 14 luces puntuales y
un NPC separado**. Esos recuentos describen el ejemplo, no límites mínimos de
un juego ni una prueba de rendimiento universal.

## Iria, modelo y animación

Iria es una técnica de mantenimiento original con vestuario de supervivencia:
el modelo y los elementos de diseño se construyen localmente. El asset tiene
**19.716 triángulos, 23 articulaciones y 19 materiales/primitivas glTF**, con
clips `Idle` y `Walk`. El [script de construcción](../scripts/build-character.py)
genera el [glTF](../assets/characters/iria.gltf) y su
[buffer binario](../assets/characters/iria.bin) en Blender; Blender se necesita
para reconstruir el modelo, no para cargarlo o animarlo en NERVA.
La [guía del modelo](character-model.md) documenta su construcción, exportación
y limitaciones de rostro, materiales y animación.

El [loader](../src/graphics/gltf.mjs) separa `parseGLTF(document, buffers)` de
`loadGLTF(url, {fetch})`. El parser recibe JSON y `ArrayBuffer` y funciona en
Node o navegador sin el motor gráfico. La carga admite `.gltf` con `.bin` o
buffers base64. El subconjunto actual incluye triángulos, factores PBR sin
texturas, cuatro pesos por vértice y animación TRS `LINEAR`/`STEP`; rechaza GLB,
texturas, morph targets, `CUBICSPLINE` y extensiones requeridas no soportadas.
No es un importador de cualquier asset glTF.

En Node, los archivos JSON/binarios se pueden leer con `node:fs` y pasar al
parser como `ArrayBuffer`; no se necesita WebGPU ni Blender para ese análisis
o el muestreo de poses. La exportación/reconstrucción del modelo original se
realiza con el script Blender enlazado, no con un exportador glTF del intérprete.

`createGLTFAnimator` mantiene arrays de trabajo y devuelve una pose reutilizable
al muestrear. Su paleta se expresa en espacio local de la malla:
`inverse(meshWorld) × jointWorld × inverseBind`. La aplicación combina la
colocación del NPC con `pose.meshWorld` una sola vez y entrega esa matriz junto
con la paleta al renderer. La [especificación glTF de Khronos](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#skins)
define la jerarquía, los atributos de joints/pesos y las matrices inverse bind.

El shader realiza skinning en GPU. Cada vértice empaqueta 96 bytes, incluidos
pesos, articulaciones y factores de material. El renderer une las 19 primitivas
en una malla, conservando sus factores por vértice: el personaje requiere
**un dibujo por pase de geometría**, no 19. Se dibuja también en reflejo y sombra.

La lógica NERVA elige estados `idle`, `walking` y `speaking`, vigila proximidad,
avanza una patrulla corta y emite el diálogo al pulsar E. `walking` selecciona
`Walk`; los otros estados usan `Idle`. El diálogo es texto original y una
máquina de estados explícita; no hay generación conversacional ni sincronización
de labios. El vestuario y el modelado no son escaneos fotogramétricos.

## Pases y decisiones visuales

```text
Sombra estática cacheada + sombra del NPC actualizado
                         ↓
Cámara reflejada → HDR a media resolución
                         ↓
Cámara principal → HDR + profundidad, con MSAA opcional
                         ↓
Resolve de color + resolve de profundidad si MSAA 4×
                         ↓
Extracción de brillos → blur horizontal → blur vertical
                         ↓
FXAA opcional + oclusión + exposición + tone mapping
                         ↓
RGBA/BGRA → presentación GPU o captura
```

El [grafo](../src/graphics/graph.mjs) prepara las dependencias y reutiliza sus
callbacks. `renderGraphSchedule` describe siete pases con una muestra y ocho
con MSAA 4×, que añade `depth-resolve`;
`renderGraphPasses` lista sólo los que se codificaron en ese cuadro. Desactivar
reflejo o bloom evita sus pases, pero no libera los targets ya reservados.
Desactivar AO pone su intensidad a cero dentro del postprocesado; el shader
omite la lectura de profundidad, reconstrucción y ocho muestras vecinas mediante
una rama uniforme. Sus planes de memoria no crean aliasing físico de texturas.

### Materiales y luces

La iluminación directa usa Cook–Torrance con distribución GGX, visibilidad
Smith correlacionada y Fresnel Schlick. Metalicidad y rugosidad permiten
contrastar suelo húmedo, acero, hormigón y superficies emisivas. Cada fragmento
evalúa las luces puntuales activas, con atenuación por distancia y radio; esas
luces no proyectan sombras. Primero descarta luces cuyo radio no alcanza el
fragmento; una superficie orientada de espaldas a una luz evita evaluar la BRDF.
La visibilidad PCF del sol sólo se consulta en superficies iluminadas por él.
Son reducciones de trabajo del shader, sin una mejora de FPS cuantificada.
El ambiente hemisférico y el cielo analítico son
aproximaciones, sin cubemaps IBL ni rebotes calculados. La documentación de
[Filament](https://google.github.io/filament/main/filament.html) explica el modelo
PBR que sirve de referencia.

Paneles, juntas, rejillas, metal cepillado, franjas de peligro, baldosas y
variación de humedad se generan en shader. El patrón 3 se reserva para rejillas;
el patrón 5 aporta estrías, manchas y variación tenue de rugosidad al acero,
plata, cobre y metal pintado de la instalación. Ese cepillado modifica color y
rugosidad, sin añadir una BRDF anisotrópica. Una perturbación analítica de la
normal añade microdetalle:
no son normal maps obtenidos de escaneo. Los colores de material se interpretan
como lineales. La niebla mezcla color según distancia y altura; no calcula
dispersión volumétrica ni haces de luz con shadow marching.

### Sombras PCF

Una cámara ortográfica ajustada a los bounds del mundo genera un shadow map
direccional `depth32float`. El material compara profundidad con un pequeño
bias y promedia una cuadrícula PCF 3 × 3 mediante un sampler de comparación.
PCF filtra resultados de visibilidad, como describe
[GPU Gems: Shadow Map Antialiasing](https://developer.nvidia.com/gpugems/gpugems/part-ii-lighting-and-shadows/chapter-11-shadow-map-antialiasing).

La sombra del entorno se dibuja la primera vez que está habilitada y se conserva
en un mapa estático porque objetos y sol son estáticos. La cámara del jugador
puede moverse sin invalidarla. Si cambian pose o transformación del NPC, se
copia esa profundidad estática al mapa de trabajo y se añade sólo la sombra
actual del personaje. Las siluetas de poses anteriores no se acumulan; si no
cambia el personaje, también se conserva el resultado combinado.

Es un mapa para toda la instalación, sin cascadas ni sombras por luz puntual;
ampliar el mundo reduce el detalle disponible por texel. Con personaje se reserva
un mapa adicional para preservar el entorno, a cambio de evitar redibujarlo en
cada pose animada.

### Reflejo del suelo

Una cámara reflejada respecto a `floorY` vuelve a rasterizar el mundo a la mitad
del ancho y alto. Invierte el winding y el shader descarta geometría bajo el
plano y superficies reflectantes para evitar retroalimentación. El suelo mezcla
esa textura usando rugosidad, variación de humedad y Fresnel. El patrón general
de cámara reflejada puede estudiarse en el código público
[three.js Reflector](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/objects/Reflector.js).

Este reflejo se limita a un plano horizontal. No es SSR, reflejo arbitrario por
objeto ni ray tracing. El filtrado es bilineal, con una pequeña distorsión por
normal; la rugosidad modula la mezcla pero no ejecuta una convolución física del
reflejo. La segunda rasterización y el shading tienen coste incluso a menor
resolución.

### HDR, bloom y oclusión aproximada

La cámara principal y el reflejo escriben en `rgba16float`, preservando luces y
emisión por encima de uno antes del tone mapping. Bloom extrae valores brillantes
a un cuarto del ancho/alto y aplica blur gaussiano separable horizontal y
vertical. Cada blur utiliza cinco lecturas bilineales que aproximan un kernel
de nueve muestras. El objetivo perceptual de bloom y su relación con brillos
se documentan en [Epic: Bloom](https://dev.epicgames.com/documentation/en-us/unreal-engine/bloom-in-unreal-engine).

El postprocesado reconstruye posiciones de vista desde profundidad y evalúa
ocho direcciones vecinas para una oclusión ambiental aproximada. Sólo conoce
lo visible en la profundidad de pantalla; puede producir halos y cambios al
mover la cámara. Se aplica al color compuesto, sin separar físicamente la
iluminación indirecta. No implementa CACAO, cuya
[documentación de AMD](https://gpuopen.com/manuals/fidelityfx_sdk/techniques/combined-adaptive-compute-ambient-occlusion/)
describe una solución más completa basada en profundidad y normales.

La salida combina oclusión y bloom, aplica exposición, una aproximación ACES,
gamma 2,2, viñeta y dither en RGBA/BGRA unorm. HDR interno no implica salida HDR
a un monitor. No hay acumulación temporal, vectores de movimiento, TAA ni
reconstrucción temporal en esta ruta.

### Antialiasing de geometría y patrones

`sampleCount` admite 1 o 4. Con cuatro muestras, el pase principal dibuja HDR y
profundidad MSAA 4×; su `resolveTarget` entrega color HDR de una muestra para
bloom y postprocesado. El patrón de textura multisample y resolve está en el
[ejemplo oficial WebGPU MSAA](https://github.com/webgpu/webgpu-samples/blob/main/sample/helloTriangleMSAA/main.ts).
El reflejo y la sombra mantienen una muestra.

Un pase adicional `depth-resolve` lee las cuatro muestras de profundidad y
guarda su mínimo en `depth32float` de una muestra. Así conserva la superficie
más cercana para AO en los píxeles con cobertura parcial. Es una decisión de
resolve de profundidad; no promedia la profundidad ni añade otra resolución
de color.

`fxaa: true` habilita un filtro de borde aproximado en el postprocesado. Estima
contraste de luminancia tras exposición/tone mapping y sólo mezcla muestras
direccionales en bordes relevantes; las regiones planas conservan su color
central. Sus lecturas de detección también tienen coste. No es acumulación
temporal ni supersampling de todos los shaders.

Los patrones procedimentales usan `fwidth` para ajustar sus transiciones al
tamaño de píxel y reducir parpadeo de juntas, rejillas y estrías subpíxel. MSAA
suaviza cobertura geométrica; ese filtrado trata detalle del material. La
combinación mejora esos casos sin prometer que elimine todo aliasing especular
o en movimiento.

## API y ciclo de vida

```js
import { createFPSWorld } from '../src/graphics/world.mjs';
import { createFirstPersonController } from '../src/graphics/camera.mjs';
import { createFPSRenderer } from '../src/graphics/fps-renderer.mjs';

const world = createFPSWorld(description);
const player = createFirstPersonController({
  ...world.spawn, colliders: world.colliders,
});
const renderer = await createFPSRenderer({
  world, width: 1280, height: 720, shadowSize: 2048,
  sampleCount: 4, fxaa: true,
});
player.step({ forward: 1 }, 1 / 60);
const stats = await renderer.render(player.camera, {
  time: 1 / 60, capture: false, readback: false,
  effects: { shadows: true, reflections: true, bloom: true, ao: true },
});
// La aplicación presenta renderer.colorTexture o llama a present(context).
renderer.dispose();
```

Las rutas del ejemplo se resuelven desde un módulo en `docs/`. El mundo de la
demo se puede preparar ejecutando `node examples/fps/prepare.mjs`; escribe su
descripción e informe CPU en `private/fps/`. Esa preparación no es una medición
de render GPU.

El contrato del personaje es plano, tanto al crear como al llamar a `render`:

| Opción | Contrato |
| --- | --- |
| `characterAsset` | Asset de `parseGLTF`/`loadGLTF`, sólo al crear; admite 1–256 articulaciones y primitivas skinned empaquetadas. |
| `characterPose` | `Float32Array` de `jointCount × 16` valores, matrices f32 finitas; inicial o actualización por cuadro. |
| `characterTransform` | `Float32Array` de 16 valores, matriz afín column-major; colocación multiplicada por `pose.meshWorld`. |
| `sampleCount` | 1 o 4, sólo al crear; determina pipelines y targets. |
| `fxaa` | Booleano, sólo al crear; vale `false` por defecto en la API. |

`createGLTFAnimator(...).sample` reutiliza la identidad de la paleta. El backend
detecta cambios por sus valores, no sólo por identidad, une articulaciones
adyacentes modificadas y sube sus rangos. Reutilizar la paleta no impide que la
GPU reciba una pose nueva. La transformación se sube cuando cambia; no se
retransmiten mallas ni materiales del personaje por cuadro.

Para abrir la demo, sirve la raíz del repositorio con
`python -m http.server 8080 --bind 127.0.0.1` y abre
`http://127.0.0.1:8080/examples/fps/` en un navegador con WebGPU. Los
[perfiles](../examples/fps/quality.mjs) calculan resolución desde el viewport y
`devicePixelRatio`, preservando la proporción y aplicando un límite explícito:

| Perfil | Resolución solicitada | Límite | Shadow map | MSAA / FXAA |
| --- | --- | --- | --- | --- |
| Alta | Viewport × DPR | 1920 × 1080 | 2048² | 4× / activo |
| Equilibrada | Viewport × DPR × 0,75 | 1280 × 720 | 1024² | 4× / activo |
| Validación | Viewport × DPR | 320 × 180 | 512² | 1× / activo |

Una ventana 1280 × 720 con DPR 1 se dibuja a 1280 × 720 en Alta. Validación es
un presupuesto para QA, no la calidad normal de exploración. El canvas sigue
cambios de tamaño a través de la cola del renderer. La escala y los límites son
configuración; no hay ajuste automático según carga ni objetivo de FPS
garantizado.

La creación admite un `GPUDevice` del anfitrión o solicita uno en el navegador.
`render` debe esperarse antes del siguiente render, resize, presentación o
dispose. `resize` recrea targets y bindings afectados y recompila el grafo;
mantiene las mallas y el mundo. `dispose` libera los recursos y sólo destruye
el dispositivo si lo creó el renderer.

La aplicación serializa frames y acciones de interfaz, mantiene los controles
deshabilitados durante inicialización y cambios de calidad y cancela callbacks
de animación de generaciones anteriores al pausar. Si se pierde el dispositivo,
pausa, deshabilita controles y muestra el error; no promete recuperación
automática de recursos tras esa pérdida.

`present(context)` copia la textura final a un `GPUCanvasContext` configurado
con uso `COPY_DST`, formato y dimensiones coincidentes. La copia permanece en
GPU. `capture: true` copia el resultado a staging, desempaqueta filas alineadas
a 256 bytes y entrega `rgba` como `Uint8Array`; crea ese buffer al primer uso.
La captura agrega trabajo y lectura CPU y se reserva para comprobaciones.

## Rendimiento y evidencia

El cuadro normal sube **512 bytes de uniforms**, sin retransmitir instancias
estáticas ni luces. Un personaje añade rangos modificados de paleta y hasta
64 bytes de transformación: para las 23 articulaciones de Iria, actualizar la
paleta completa y la transformación añade 1.536 bytes. Cuando nada cambia,
esas subidas del personaje son cero. Los contadores separan `boneUploadBytes`
y `characterTransformUploadBytes`. Después del calentamiento los recursos
gráficos se reutilizan; command encoders y command buffers por cuadro no forman
parte del contador de recursos persistentes.

Con cuatro lotes, un personaje, todos los efectos y MSAA 4×, el primer cuadro
puede emitir 20 draw calls: doce del entorno, tres del personaje y cinco
fullscreen. Con la sombra estática cacheada y pose nueva, pasa a 16; si la pose
y transformación tampoco cambian, se omite la sombra del personaje y queda en
15. El contador real depende de lotes y efectos ejecutados. `sceneTriangles`
cuenta una copia del mundo estático; `skinnedTriangles`, la malla del personaje;
`trianglesSubmitted` cuenta ambas según sus pases y omite los fullscreen.
`characterDrawCalls` y `npcShadowRendered` permiten comprobar ese trabajo.

Los targets incluyen salida y HDR/profundidad de una muestra a resolución
completa, reflejo/profundidad a media dimensión, tres targets de bloom a cuarta
dimensión y shadow map. MSAA 4× añade color y profundidad multisample además
de los targets resueltos; un personaje añade la sombra estática conservada.
Para dimensiones divisibles por cuatro, los bytes lógicos aproximados son:

| Configuración | Targets, antes de buffers/capturas/presentación |
| --- | --- |
| Una muestra, sin NPC | `20.5 × ancho × alto + 4 × shadowSize²` |
| MSAA 4×, sin NPC | `68.5 × ancho × alto + 4 × shadowSize²` |
| MSAA 4×, con NPC | `68.5 × ancho × alto + 8 × shadowSize²` |

No describen toda la memoria del driver ni sus posibles optimizaciones internas.
Bajar resolución reduce shading y superficies; desactivar reflejo o bloom
omite su ejecución pero conserva sus reservas en esta versión. La copia del
shadow map y el skinning también consumen trabajo GPU aunque no reconstruyan
la geometría en CPU.

La aplicación registra `cpuAnimationMs` por separado para muestrear la pose
glTF y componer la matriz de colocación del personaje. `cpuLogicMs` corresponde
a la ejecución NERVA, movimiento y actualización del bloqueador del NPC.
`cpuEncodeMs` mide codificación y envío CPU del renderer: no incluye ese
muestreo/composición previo ni la lógica NERVA, y excluye finalización GPU. Con
`profile: true` y `timestamp-query` habilitado, un cuadro con `readback: true`
devuelve `gpuPassTimesMs` para los pases efectivamente ejecutados y `gpuTimeMs`
como suma. Excluye subidas, lectura CPU y copia de presentación. Si la capacidad
no está habilitada, el profiling está desactivado o no se solicita readback,
esas métricas son `null`; `gpuTimestampStatus` identifica el caso. El backend
solicita la capacidad si crea un dispositivo y el adaptador la ofrece; un device
externo debe tenerla habilitada previamente.

La primera etapa `shadow` con NPC puede abarcar dos render passes y la copia
entre ambos bajo un par de timestamps; su duración incluye ese intervalo.
Con entorno ya cacheado, los timestamps de sombra rodean el pase del personaje,
por lo que la copia previa no forma parte de esa duración. El total sigue sin
representar todo el coste GPU del cuadro ni la presentación.

El resolve de queries procesa sólo los pares escritos por pases ejecutados en
ese cuadro, con destinos alineados a 256 bytes. Una sombra cacheada o un efecto
desactivado no aporta un timestamp nuevo y no se resuelven sus slots: esto evita
medir valores antiguos o slots que nunca llegaron a escribirse.

Un intervalo de `requestAnimationFrame`, un tiempo de preparación NERVA o una
suma de pases no acreditan por sí solos la latencia completa ni una tasa estable
de FPS. A 60 FPS el presupuesto de cuadro es 16,67 ms; a 120 FPS, 8,33 ms. Hay
que guardar resolución, adaptador, driver, efecto y escena, separar CPU/GPU y
medir percentiles tras calentamiento. Chromium/SwiftShader comprueba ejecución
y corrección de shaders mediante software; sus timestamps no son resultados de
una GPU física.

La presentación del navegador usa directamente el canvas WebGPU. El
[helper de Chromium](../scripts/probe-webgpu.py) habilita el backing Vulkan de
SwiftShader para esa presentación en Linux headless; validar compute o targets
fuera de pantalla por sí solo no comprueba el canvas. La ruta de prueba mantiene
los mismos shaders y recursos y no sustituye el dibujo por un canvas 2D.

Las comparaciones visuales deben apagar individualmente sombras, reflejo,
bloom y AO y mantener la misma cámara. Las verificaciones funcionales cubren
orientación, desplazamiento, colisión estática y bloqueo dinámico del NPC,
actualización atómica de colliders, misión/NPC, paletas Idle/Walk, sombra
dinámica, modos AA, creación/resize/dispose, captura y uso válido de WebGPU.
Una imagen industrial coherente acredita esa escena;
no acredita assets fotogramétricos, GI, ray tracing ni rendimiento de un motor
AAA completo. Esas capacidades exigirían implementación y evaluación propias.
