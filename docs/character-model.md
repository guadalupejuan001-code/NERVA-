# Iria: personaje original de supervivencia

Iria es una técnica de mantenimiento adulta de aproximadamente 1,72 m. Su
silhouette, ropa y rostro se generan en Blender desde código propio. El diseño
busca el tono de un juego de terror y supervivencia: ropa de trabajo azul oscuro,
pantalón oliva, pañuelo óxido, botas, bolsillos, arnés y un instrumento de servicio.
No usa modelos, imágenes, logotipos ni personajes de una franquicia existente.

La geometría incluye mandíbula y pómulos, nariz con puente y aletas, labios,
párpados, ojos con iris y pupila, orejas, pelo corto asimétrico, palmas y dedos.
Las prendas añaden cierre, costuras, paneles de reparación, bolsillos y hebillas.
Son superficies originales con normales suavizadas, UV y factores PBR para color,
metal y rugosidad. No requieren descargas de texturas para ejecutarse.

## Reproducir el modelo

Desde la raíz del repositorio, con Blender 4.3 o posterior:

```sh
blender --background --python scripts/build-character.py -- --output assets/characters
```

El [generador](../scripts/build-character.py) escribe
[iria.gltf](../assets/characters/iria.gltf) y
[iria.bin](../assets/characters/iria.bin). Guarda además el archivo de autoría y el
reporte de construcción en `private/character/`, fuera del control de versiones.
El motor carga glTF y bin; Blender sólo se necesita para regenerarlos.

La opción `--preview` produce una imagen de revisión de la forma en Blender. Esa
imagen no es una captura del motor WebGPU. Las capturas del ejemplo FPS se obtienen
de su renderizador real en el navegador.

## Deformación y animación

Un único mesh contiene primitivas separadas por material y comparte una skin de
23 articulaciones: raíz, pelvis, tres tramos de columna, cuello, cabeza, clavículas,
brazos, antebrazos, manos, muslos, pantorrillas, pies y dedos de los pies. Los pesos
mezclan articulaciones vecinas en torso, codos y rodillas; los detalles del rostro,
pelo, ojos y orejas siguen la cabeza. Cada vértice usa a lo sumo dos influencias.

`Idle` dura 2,4 segundos y anima respiración y balanceo leve. `Walk` dura 1,1
segundos y alterna brazos y piernas con flexión de rodilla y desplazamiento vertical
de la raíz. Los clips guardan canales TRS de los nodos, con interpolación LINEAR o
STEP; no almacenan copias del mesh para cada cuadro. El personaje usa metros,
eje Y vertical y eje +Z frontal en glTF. El nodo mesh y el nodo armature son
identidad: la transformación de colocación en el mundo se aplica en el motor.

La topología está triangulada y exporta `POSITION`, `NORMAL`, `TEXCOORD_0`,
`JOINTS_0` y `WEIGHTS_0`, además de matrices inversas de enlace. No usa compresión,
accessors sparse, morph targets ni mapas de textura externos. El presupuesto del
generador permanece entre 10.000 y 30.000 triángulos, con 19 materiales.

## Qué falta para una producción final

El modelo es un personaje procedural con apariencia estilizada. Una piel
fotorrealista requiere una pasada artística de escultura, retopología y mapas de
albedo, normal y rugosidad; el sombreador de piel necesitaría transmisión o
subsuperficie. Para escenas cercanas también faltan rig facial, animaciones
interpretadas por un actor, IK de pies y manos, telas dinámicas y LOD preparados.
La silueta, rig, formato y animaciones actuales sirven como base ejecutable para
probar esos sistemas sin sustituirlos por imágenes prerenderizadas.
