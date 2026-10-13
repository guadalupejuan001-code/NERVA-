# Base de motor gráfico WebGPU

Este prototipo une NERVA como controlador de escenas con datos persistentes y
trabajo por lotes en GPU. El [diseño y sus fuentes](../../docs/arquitectura-grafica.md)
detallan la arquitectura y las etapas hacia un motor de producción.

## Ejecutar

Desde la raíz, Node.js 18+ y sin dependencias npm:

```sh
npm run demo:engine
```

`init.nv` crea una escena mediante `host.create_scene`; `frame.nv` modifica
instancias y solicita dibujos usando el identificador devuelto. El anfitrión
retiene el estado entre ejecuciones del intérprete. El programa prepara una
escena de 10.000 instancias y tres cuadros, incluyendo dos modificaciones.
Los comandos ocupan menos de 1 KB; los buffers no pasan por la frontera JSON.
Se guardan comandos e informe CPU en `private/graphics-engine/`.
Los rangos del controlador persisten en el anfitrión; cada ejecución `.nv`
conserva la semántica habitual de estado nuevo del intérprete.

Para ver y validar el dibujo, sirve la raíz del repositorio:

```sh
python -m http.server 8080 --bind 127.0.0.1
```

Abre `http://127.0.0.1:8080/examples/graphics-engine/` en un navegador con WebGPU
y pulsa «Ejecutar prueba». La demo usa captura de GPU para mostrar y comprobar
el resultado; esa lectura CPU no se necesita en la ruta normal del renderer.

El helper automatizado requiere Python, Playwright y Chromium disponibles:

```sh
npm run test:engine:webgpu
npm run report:engine
```

El helper fuerza SwiftShader para repetir la validación en software. Para probar
el adaptador que el navegador seleccione, usa:

```sh
python scripts/probe-webgpu.py --adapter auto \
  --page examples/graphics-engine/index.html \
  --out private/graphics-engine/hardware-report.json
```

`auto` no garantiza un adaptador físico: comprueba la información del informe.
`--chromium` permite seleccionar otra instalación. No hace falta Python ni
navegador para el intérprete o `npm test`; las pruebas GPU son una verificación
adicional y fallan si WebGPU no está disponible.

## Contrato del backend

```js
import { createScene, defaultCamera, createWebGPURenderer } from '../../src/graphics/index.mjs';

const scene = createScene({ count: 100_000, seed: 7 });
const renderer = await createWebGPURenderer({ scene, width: 1280, height: 720 });
scene.updateInstances([{ index: 9, position: [1, 2, 30] }]);
const stats = await renderer.render(defaultCamera({ aspect: 1280 / 720 }), { readback: false });
// renderer.colorTexture contiene el cuadro; la aplicación presenta la textura.
renderer.dispose();
```

Sólo un renderer puede poseer una escena a la vez. Mientras exista, deja el
consumo de rangos modificados al renderer y cambia datos con `updateInstances`.
Escribir directamente en los arrays omite el seguimiento. `dispose` libera
buffers/texturas y la propiedad de la escena; hay que esperar el `render`
pendiente antes de modificar tamaño o liberar recursos.

`readback: true` devuelve contadores e IDs para verificar CPU/GPU;
`capture: true` añade bytes RGBA con filas desempaquetadas. Los staging buffers
se crean al primer uso y se reutilizan. Un cuadro normal puede usar ambos en
`false` y mantener resultados en GPU. La cámara mira hacia `+Z`, con posición,
perspectiva y distancias LOD; la geometría actual es una familia de esferas.

La opción de creación `profile: true` activa timestamps cuando el `GPUDevice`
habilita `timestamp-query`. En cuadros con `readback: true`, `gpuPassTimesMs`
separa culling/LOD y dibujo; `gpuTimeMs` suma esos dos pases y excluye subidas,
resets y capturas. Sin capacidad habilitada o sin lectura, los tiempos GPU son
`null`. `cpuEncodeMs` mide siempre codificación/envío CPU. La demo habilita esta
capacidad si el adaptador la ofrece; no convierte sus tiempos de software en
resultados de hardware físico.

## Qué comprueba

- Un millón de instancias en la referencia CPU: 32 MB de datos de escena.
- Una sola escena creada desde NERVA y reutilizada entre cuadros.
- GPU frustum y LOD coincidentes con la referencia CPU, sin IDs repetidos.
- 64 bytes de datos de escena para cambiar dos instancias; cero en cuadro estático.
- Recursos GPU estables después del primer uso de captura/lectura.
- Grafo que ejecuta clear → cull → draw, tres dibujos indirectos y profundidad.
- Escena vacía, liberación, resize y captura con filas alineadas.
- 100.000 instancias procesadas y dibujadas mediante WebGPU en el stress test.

Las métricas de memoria son bytes lógicos de buffers y estimaciones de texturas;
no incluyen todo el driver. Los tiempos CPU, la finalización de validación y
los tiempos GPU se identifican por separado. Una reducción de triángulos mide
trabajo de geometría evitado; no implica el mismo porcentaje de mejora en FPS.
La ejecución inicial utiliza SwiftShader y acredita corrección funcional.
Iluminación global, sombras, texturas, assets glTF, oclusión, streaming,
reconstrucción temporal y backends nativos son etapas documentadas pendientes.

La [evidencia inicial](../../experiments/results/0.3.0/graphics-engine.json)
guarda adaptador, versiones, resoluciones, métricas y hashes de fuentes. En el
cuadro estático de 10.000 instancias, 6.720 resultan visibles; los tres LOD
dibujan 111.536 triángulos frente a 1.505.280 si esos mismos visibles usaran
detalle alto. Es aproximadamente un 92,6 % menos de triángulos, sin atribuir
esa reducción a FPS. El stress de 100.000 utiliza también los tres LOD
predeterminados, a 320 × 180, con sus resultados completos en el informe.
