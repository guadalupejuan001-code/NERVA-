# Geometría gráfica en NERVA

Prueba offline de un cubo 3D en wireframe. NERVA construye ocho vértices y doce
aristas, calcula matrices de rotación y proyecta los puntos a la pantalla.
JavaScript aporta seno/coseno, recibe el buffer de líneas y dibuja imágenes SVG y
PNG con un backend de CPU sin dependencias npm.

Desde la raíz del repositorio:

```sh
npm run demo:graphics
```

Se generan tres cuadros con ángulos distintos y un informe JSON en
`private/graphics/`. Para elegir otro destino:

```sh
npm run demo:graphics -- --out private/otra-escena
```

`scene.nv` importa `lib/geometry.nv`. El anfitrión prepara el proyecto una vez y
lo ejecuta con datos de cámara y rotación nuevos por cuadro. Usa
`captureGlobals:false`; `host.present` recibe un único frame con puntos y líneas,
y devuelve `null`. El estado entre cuadros pertenece al anfitrión.

El backend recorta líneas contra el viewport antes de rasterizarlas. La geometría
rechaza vértices que toquen o crucen el plano cercano; todavía no recorta mallas
en 3D. Los cuadros son exportaciones offline, sin GPU, profundidad, texturas,
iluminación ni una medición de velocidad de un bucle en tiempo real.

Esta separación permite sustituir la presentación por Canvas, WebGL o WebGPU.
La inicialización asíncrona del dispositivo y los recursos debe quedar fuera del
runtime síncrono; NERVA puede emitir comandos a un backend ya preparado. Una
integración en navegador también necesita adaptar la resolución de módulos
actual, que utiliza `node:path`.

Las pruebas de `tests/graphics.test.mjs` comprueban perspectiva conocida, rotación,
preparación reutilizable, cámara, clipping y el contenido de las imágenes.
