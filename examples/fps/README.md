# SECTOR 07 · demo en primera persona

NERVA construye una instalación industrial explorable: 446 piezas, cuatro tipos
de geometría, 14 luces puntuales y materiales procedurales. `control.nv` se
ejecuta directamente en el navegador para dirigir movimiento, mirada, misión
e interacción con Iria. El anfitrión mantiene cámara, colisiones y estado entre
ejecuciones; WebGPU dibuja el entorno y anima el personaje.

## Abrir la instalación

Desde la raíz del repositorio:

```sh
python -m http.server 8080 --bind 127.0.0.1
```

Abre `http://127.0.0.1:8080/examples/fps/` en un navegador compatible con WebGPU.
Pulsa **ENTRAR** para capturar el ratón. **Conocer a Iria** acerca la cámara al
personaje y pausa el movimiento. Puedes volver a entrar para caminar y hablar.
No se necesita Node ni un paso de preparación para jugar.

- WASD: caminar; ratón: mirar.
- Shift: correr; Espacio: saltar.
- E: hablar con Iria al acercarte o inspeccionar la consola del núcleo.
- Esc: pausar y liberar el ratón.

Alta solicita la resolución de la ventana multiplicada por su densidad de
píxeles, con un límite proporcional de 1920×1080. Equilibrada usa el 75 % de
esa resolución y un límite de 1280×720. Ambas usan MSAA 4× y FXAA. Una ventana
1280×720 con densidad 1 se dibuja a 1280×720 en Alta. Validación usa hasta
320×180 y una muestra para reducir el coste de las pruebas en software.
«Efectos» compara la imagen y «Métricas» muestra adaptador, cargas y tiempos.

## Moldear un personaje

[Iria](../../docs/character-model.md) es una técnica de mantenimiento original:
pelo corto, chaqueta azul oscura, pañuelo oxidado y equipo de trabajo. La malla
procedural tiene 19.716 triángulos, 23 articulaciones y clips `Idle` y `Walk`.
El generador Blender crea geometría, materiales, pesos y animaciones; exporta
[`iria.gltf`](../../assets/characters/iria.gltf) y su buffer binario.

Con Blender instalado, puedes modificar proporciones, ropa y detalles en
[`build-character.py`](../../scripts/build-character.py), y reconstruir:

```sh
npm run build:character
```

`scene.nv` configura posición, patrulla, distancia y texto de interacción.
`control.nv` decide los estados de espera, marcha y diálogo. El cargador glTF
evalúa la animación; el shader de skinning deforma la malla en GPU y conserva
sombras y reflejos del personaje. El modelo actual es estilizado y procedural.

## Verificar

Node.js 18+ permite comprobar la autoría y lógica sin navegador:

```sh
npm run demo:fps
npm test
```

Las pruebas WebGPU adicionales requieren Chromium y Python Playwright:

```sh
npm run test:fps:webgpu
npm run test:fps:controls
npm run test:fps:renderer
npm run test:fps:character
npm run report:fps
```

Las pruebas comparan efectos y capturas, validan ocho controles e interacciones
reales, verifican orientación, resize y liberación de recursos, y comprueban
que la animación cambia los píxeles del personaje, sus sombras y sus reflejos.
Los informes y PNG se guardan en `private/fps/`. Los helpers eligen SwiftShader
para una verificación reproducible; `--adapter auto` permite usar el adaptador
elegido por el navegador. El informe versionado está en
[`fps.json`](../../experiments/results/0.3.0/fps.json).

## Alcance visual y rendimiento

El [pipeline FPS](../../docs/fps-renderer.md) usa sombras direccionales PCF,
reflejo planar a media resolución, HDR, bloom a un cuarto de resolución, AO
aproximado por profundidad y niebla analítica. El filtrado según tamaño del
píxel reduce el parpadeo de los materiales procedurales.

Las mallas, materiales y luces persisten en GPU. Los 19 grupos de materiales de
Iria se combinan en un dibujo por pase. Cada cuadro sube 512 bytes de cámara;
la pose de sus 23 articulaciones requiere 1.472 bytes cuando cambia, sin volver
a subir los vértices. La sombra del entorno estático se conserva y la del
personaje se actualiza al cambiar su pose o transformación.

La presentación copia la textura final al canvas WebGPU. Las capturas leen
bytes de esa textura. El ambiente, la niebla y el AO son aproximaciones; no hay
iluminación global, ray tracing ni reconstrucción temporal. La colisión usa un
cuerpo AABB conservador con deslizamiento y gravedad. La validación con
SwiftShader comprueba funcionamiento e imagen; el rendimiento de un juego
con assets de producción requiere medir una GPU física.
