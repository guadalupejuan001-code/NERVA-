# Arquitectura gráfica de NERVA

El objetivo es que NERVA describa y controle escenas exigentes mientras un
backend especializado conserva los recursos y ejecuta el trabajo masivo en GPU.
La optimización empieza por hacer menos trabajo, mover menos datos y medir los
costes de cada pase. Este documento distingue el prototipo disponible de las
etapas necesarias para convertirlo en un motor de producción.

El diseño se basa en el estudio de documentación, publicaciones y código públicos
de sus autores. Es una selección de técnicas compatibles; no constituye una
ingeniería inversa exhaustiva de motores privados ni incorpora Nanite, Lumen,
Filament o FidelityFX como sistemas completos.

## Contrato entre lenguaje y renderer

```text
NERVA: configuración, comportamiento y cambios de instancias
                         ↓ comandos pequeños
Anfitrión: escena persistente y buffers tipados
                         ↓ subida inicial + rangos modificados
GPU: frustum → elección de LOD → listas compactas de visibles
                         ↓ tres comandos indirectos
Triángulos + profundidad + material → textura de color
                         ↓ presentación o captura
Validación y métricas reproducibles
```

El intérprete de NERVA 0.3 conserva su contrato síncrono. `prepareProgram`
reutiliza el programa analizado, pero cada `run` crea ámbitos y módulos nuevos.
El estado gráfico persistente pertenece al anfitrión; la finalización asíncrona
de WebGPU también se resuelve allí. Las funciones `host` reciben copias JSON:
conviene utilizarlas para órdenes pequeñas o lotes de cambios, manteniendo
geometría y recursos fuera de ese intercambio. No existe compilación automática
de programas `.nv` a shaders. Véase la [referencia del lenguaje](lenguaje.md).

Esta separación permite ampliar los backends sin reconstruir todas las listas
del lenguaje en cada cuadro. Los shaders de la implementación actual están
escritos explícitamente en WGSL y las llamadas WebGPU son JavaScript.

El puente [commands.mjs](../src/graphics/commands.mjs) ya registra
`create_scene`, `update_instances` y `render_scene`. Devuelve identificadores
como `scene-1`, retiene los arrays y acepta órdenes JSON con opciones, cambios
o cámara. `drain()` entrega las órdenes pendientes a la aplicación que ejecuta
WebGPU. Los buffers persistentes no forman parte de esas órdenes.

```nv
nerva 0.3
const scene_handle = host.create_scene({count: 10000, seed: 7, spread: 70})
host.update_instances(scene_handle, [{index: 0, position: [0, 0, 10]}])
host.render_scene(scene_handle, {position: [0, 0, 0]})
```

El [ejemplo graphics-engine](../examples/graphics-engine/README.md) prepara una
escena desde `init.nv` y ejecuta `frame.nv` tres veces usando el mismo anfitrión
y pasando su identificador como entrada. Las órdenes describen una creación,
cámaras y dos cambios de instancia; la escena persiste entre esas ejecuciones.
El navegador reproduce las órdenes y valida el renderer. El flujo evita copiar
la escena completa a través del contrato JSON del lenguaje.

## Componentes implementados

| Componente | Código | Alcance actual |
| --- | --- | --- |
| Escena persistente | [scene.mjs](../src/graphics/scene.mjs) | Dos arrays `Float32Array`, cambios por lotes, revisiones y rangos modificados. |
| Puente de comandos | [commands.mjs](../src/graphics/commands.mjs) | Funciones síncronas del anfitrión, identificadores de escena y órdenes JSON para el consumidor GPU. |
| Referencia CPU | [scene.mjs](../src/graphics/scene.mjs) | Frustum de seis planos contra esferas y elección entre tres LOD por distancia. |
| Planificador de pases | [graph.mjs](../src/graphics/graph.mjs) | Dependencias, validación, vidas útiles y plan de reutilización; ejecuta los pases del backend. |
| Shaders GPU | [shaders.mjs](../src/graphics/shaders.mjs) | Culling, LOD, compactación de IDs y material dieléctrico con iluminación directa. |
| Backend WebGPU | [webgpu.mjs](../src/graphics/webgpu.mjs) | Recursos residentes, tres dibujos indexados indirectos y targets de color/profundidad fuera de pantalla. |

### Escena: 32 bytes por instancia

La representación separa atributos en arrays, siguiendo una organización SoA
por grupos `vec4`:

| Array | Componentes por instancia | Bytes |
| --- | --- | ---: |
| `positions` | posición `x, y, z` y radio | 16 |
| `colors` | color `r, g, b` y rugosidad | 16 |
| Total de datos de escena | ocho valores f32 | 32 |

Los buffers mantienen su identidad. `updateInstances` valida el lote antes de
modificar el estado, incrementa la revisión y une rangos contiguos o solapados.
El backend sube ambos atributos para cada rango: un rango de 100 instancias
requiere 3.200 bytes de datos de escena. Después de la subida inicial, un cuadro
sin cambios sube cero bytes de escena; el uniforme de cámara se actualiza por
separado. Escribir directamente en los arrays omite este seguimiento: las
modificaciones deben pasar por `updateInstances`.

Sólo un renderer WebGPU activo puede poseer la misma escena. Durante su uso,
el consumo de rangos modificados pertenece al renderer: otro consumidor no debe
llamar a `consumeDirtyRanges`. `dispose` libera recursos y propiedad de escena.
Hay que esperar la operación `render` pendiente antes de liberar o redimensionar.

Los 32 bytes describen los arrays de escena, no la memoria total del motor. La
copia GPU, los IDs visibles, las mallas, los targets y las capturas añaden memoria.
El máximo defensivo de un millón de instancias tampoco acredita que un
dispositivo pueda dibujarlas dentro de un presupuesto concreto.

El principio de agrupar datos contiguos y procesar componentes por lotes aparece
en [Unity Entities: archetypes](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/concepts-archetypes.html).
Su [Job System](https://docs.unity3d.com/6000.0/Documentation/Manual/job-system-overview.html)
añade trabajo CPU paralelo y dependencias. NERVA todavía no tiene un scheduler
equivalente ni compilación de sus operaciones a kernels CPU nativos.

### Frustum, tres LOD y dibujo indirecto

Un dispatch compute prueba las esferas de las instancias contra el frustum y
selecciona el LOD por distancia. Cada instancia visible reserva un índice
mediante un contador atómico y escribe su ID en la región de ese LOD. El orden
de los IDs GPU no es estable; la validación debe comparar conjuntos y
clasificaciones, no el orden de ejecución de las invocaciones.

Cada región tiene capacidad para todas las instancias. Este reparto evita una
compactación global adicional a cambio de reservar 12 bytes por instancia para
IDs, aunque cada visible ocupe una sola región. La compactación actual es por
LOD, no un almacenamiento global ajustado al número de visibles.

El renderer prepara tres mallas de esfera con 224, 48 y 8 triángulos y emite
exactamente tres `drawIndexedIndirect`. Esos tres dibujos corresponden a una
familia de mallas y material; incorporar modelos diferentes requiere agrupar
por geometría, material y LOD. El número de dibujos de un motor completo no
permanecerá necesariamente en tres.

Cada comando indirecto ocupa 20 bytes: `indexCount`, `instanceCount`,
`firstIndex`, `baseVertex` y `firstInstance`; `baseVertex` se interpreta como
entero con signo. La GPU actualiza `instanceCount`. Mantener `firstInstance`
en cero evita exigir la capacidad opcional `indirect-first-instance`; el shader
usa el índice de LOD para encontrar su región de IDs. Consulte la
[referencia oficial WebGPU de comandos de dibujo](https://gpuweb.github.io/types/interfaces/GPURenderCommandsMixin.html).

La cámara pública actual tiene posición y perspectiva y mira hacia `+Z`.
No expone rotación de cámara. Los umbrales LOD son distancias, no error
proyectado en píxeles. No hay oclusión GPU, meshlets, jerarquía de clusters,
streaming ni selección de detalle por error de imagen.

La residencia e instancing aprovechan el mismo principio de reducir envíos CPU
descrito por [Unity GPU Resident Drawer](https://docs.unity3d.com/6000.0/Documentation/Manual/urp/gpu-resident-drawer.html).
Su beneficio depende de la escena y es mayor cuando objetos numerosos comparten
mallas. [Nanite](https://dev.epicgames.com/documentation/unreal-engine/nanite-virtualized-geometry-in-unreal-engine)
lleva el detalle adaptativo más lejos mediante clusters jerárquicos preparados
al importar y datos transmitidos bajo demanda. Es una referencia para etapas
futuras; los LOD de esferas actuales no implementan ese sistema.

### Profundidad y materiales

El pase rasteriza triángulos, descarta caras traseras y escribe profundidad en
`depth24plus`. El color se guarda en una textura `rgba8unorm` o `bgra8unorm`
fuera de pantalla. El anfitrión puede presentar esa textura; la textura sola no
constituye un bucle de ventana, entrada y animación.

El shader usa GGX, una aproximación geométrica de Schlick y Fresnel Schlick para
un material dieléctrico, una luz direccional, ambiente constante, aproximación de
tone mapping ACES y corrección gamma. No hay metalicidad, texturas, normal maps,
sombras, IBL ni iluminación global. Este subconjunto PBR no reproduce el modelo
completo de [Filament](https://google.github.io/filament/main/filament.html), cuya
documentación sirve como referencia de ecuaciones, materiales y unidades.

La iluminación compleja debe tener su propio presupuesto. La
[guía de rendimiento de Lumen](https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-performance-guide-for-unreal-engine)
documenta cachés, resolución interna y costes de actualizar/trazar escenas.
Iluminación y reflejos con ray tracing añaden trabajo y estructuras de
aceleración; incluirlos no acelera automáticamente una escena rasterizada.

### Grafo: dependencias y vidas útiles

`RenderGraph` valida recursos declarados, lecturas sin inicializar y ciclos.
Preserva los conflictos de acceso en orden de declaración: escritura antes de
lectura, lectura antes de escritura y escritura antes de escritura. Los pases
independientes pueden ordenarse mediante `after`. El plan preparado conserva
sus callbacks y sólo admite ejecución síncrona de la codificación de comandos.

El plan calcula primer y último uso y asigna IDs de almacenamiento reutilizables
entre recursos transitorios con vidas que no se solapan, tipo compatible,
alineación y capacidad suficientes. Sus métricas describen ese plan, no memoria
GPU asignada. Un ID compartido no crea un `GPUBuffer`, no verifica formatos o
usos de texturas y no establece barreras nativas.

El renderer WebGPU compila un grafo y ejecuta sus callbacks para
`clear-counts`, `cull-and-lod` y `forward-opaque`. El plan se reutiliza entre
cuadros y se recompila al cambiar la resolución. Las métricas incluyen los
pases ejecutados y la memoria del plan. Los recursos reales del backend son
residentes y se crean explícitamente; todavía falta un allocator que aplique
reutilización a recursos transitorios de futuros pases. Esta primera versión
no implementa aliasing físico GPU, eliminación automática de pases, colas async
compute ni grabación paralela de comandos. La API WebGPU gestiona sus propias
reglas de uso y sincronización.

El [Render Dependency Graph de Epic](https://dev.epicgames.com/documentation/en-us/unreal-engine/render-dependency-graph-in-unreal-engine)
es la referencia para añadir optimización del cuadro completo, recursos
transitorios y validación. Su allocator y mecanismos nativos no están presentes
por usar un grafo con nombres y dependencias.

## Memoria, transferencias y medición

Para `N` instancias, los arrays CPU de escena usan `32N` bytes y sus copias GPU
otros `32N`. Las listas de visibles GPU reservan `12N`. Los tres comandos
indirectos suman 60 bytes, y el uniforme de cámara, 128. Se añaden las mallas,
sus uniforms y los targets. Por ejemplo, 100.000 instancias requieren 3,2 MB de
arrays CPU y 4,4 MB de buffers GPU de escena/visibles antes de otros recursos.

El backend mantiene contadores de buffers, bytes subidos y creaciones de
recursos. La memoria de texturas se estima: `depth24plus` tiene representación
dependiente de la implementación. Tampoco se cuentan memoria del driver,
compilador, metadata ni superficies adicionales de presentación.

La validación con `readback: true` reserva staging y copia IDs y contadores a
CPU. La captura RGBA añade otro staging con filas alineadas a 256 bytes.
Para la ruta normal debe elegirse `readback: false, capture: false`: conserva
visibles en GPU y evita esas transferencias. La API permite activarlas para
comprobaciones y capturas, no como requisito del dibujo.

`cpuEncodeMs` mide codificación y envío de comandos; excluye finalización GPU.
La opción de creación `profile` vale `false` por defecto. Con `profile: true`,
el backend utiliza timestamps si el `GPUDevice` tiene habilitada la capacidad
`timestamp-query`. Si el backend crea el dispositivo, solicita esa capacidad
cuando el adaptador la ofrece. Un dispositivo suministrado por la aplicación
debe haberla habilitado previamente: el soporte del adaptador por sí solo no
basta.

En cuadros con `readback: true`, las métricas de profiling son:

| Métrica | Qué mide |
| --- | --- |
| `gpuPassTimesMs.cullAndLOD` | Duración del pase compute de frustum, LOD y compactación. |
| `gpuPassTimesMs.forwardOpaque` | Duración del pase rasterizado de triángulos y material. |
| `gpuTimeMs` | Suma de esas dos duraciones; excluye subidas, reset de contadores, readbacks y trabajo CPU. |
| `gpuMeasuredSpanMs` | Intervalo desde el primer timestamp compute al último timestamp raster; puede incluir tiempo entre pases. |

No son el tiempo completo de un cuadro ni una medida directa de FPS. Si
`profile` está desactivado, el dispositivo carece de la capacidad habilitada o
el cuadro usa `readback: false`, las tres métricas de tiempos GPU son `null`.
`gpuTimestampStatus` distingue esos casos. Las queries se resuelven y leen como
parte de la ruta de validación; aún no hay un anillo de lectura diferida para
profiling continuo sin esas lecturas de visibilidad.

La capacidad es opcional y el navegador puede cuantizar los resultados,
incluyendo duraciones muy cortas que aparecen como cero; consulte
[Chrome WebGPU: developer features](https://developer.chrome.com/docs/web-platform/webgpu/developer-features).
Una espera de cola incluye otros costes y no sustituye esa medición por pase.
Los timestamps de SwiftShader describen su ejecución con el backend de software,
no el rendimiento de hardware físico.

### Presupuestos objetivo

Estos son presupuestos para diseñar y evaluar, no resultados ni promesas de FPS.
La carga también depende de visibilidad, materiales, luces, sombras, resolución
interna, memoria y hardware.

| Resolución de salida | Píxeles | Objetivo | Tiempo total por cuadro | Color + profundidad estimados, una pareja |
| --- | ---: | ---: | ---: | ---: |
| 1920 × 1080 | 2,07 millones | 60 FPS | 16,67 ms | 16,59 MB |
| 2560 × 1440 | 3,69 millones | 60 FPS | 16,67 ms | 29,49 MB |
| 3840 × 2160 | 8,29 millones | 60 FPS | 16,67 ms | 66,36 MB |
| 2560 × 1440 | 3,69 millones | 120 FPS | 8,33 ms | 29,49 MB |

Los MB de la tabla son decimales y usan una estimación de ocho bytes por píxel.
No incluyen múltiples cuadros en vuelo, G-buffers, HDR, sombras, historia
temporal ni capturas. El objetivo de evaluación inicial será mantener el p95
del trabajo gráfico por debajo del 80 % del presupuesto, reservando margen para
variación de carga. CPU y GPU se evalúan por separado porque pueden solaparse;
sumar todos sus tiempos no describe necesariamente la latencia del cuadro.

Cada informe debe guardar escena y semilla, resolución interna/salida,
adaptador/backend, calentamiento, visibles por LOD, triángulos, dibujos,
transferencias, estimaciones de memoria y tiempos p50/p95/p99. Una escena de
100.000 esferas repetidas comprueba instancing y LOD, pero no representa los
costes de un juego con texturas, personajes, partículas y materiales diversos.

### Qué acredita cada validación

- Las pruebas CPU comprueban estado persistente, validación de cambios, memoria
  de arrays, frustum, clasificación LOD y reglas del planificador.
- Una ejecución WebGPU comprueba compilación WGSL, uso válido de recursos,
  visibilidad frente a la referencia CPU, actualizaciones y captura de imagen.
  En límites de planos/LOD puede haber diferencias de redondeo f32.
- Chromium con un adaptador de software, como SwiftShader, ejecuta esta ruta y
  aporta evidencia funcional. Sus tiempos no acreditan rendimiento de una GPU
  física.
- Los objetivos de FPS y resolución requieren repetir escenas en GPU física,
  identificar dispositivo/driver y medir pases y estabilidad. Debe separarse
  explícitamente esa evidencia de la validación con software.

## Etapas siguientes y criterio de avance

| Etapa | Trabajo | Evidencia necesaria para avanzar |
| --- | --- | --- |
| Assets preparados | Importar glTF; optimizar índices y atributos; generar LOD, bounds y paquetes con hashes durante el build. | Calidad/error medidos, carga reproducible y bytes/tiempo de importación frente al formato de origen. |
| Visibilidad avanzada | HZB conservador, rotación de cámara, LOD por error proyectado e histéresis; grupos de geometría/material. | Sin desapariciones incorrectas al mover cámara u objetos; ahorro GPU mayor que el coste de culling. |
| Iluminación y materiales | Texturas/normal maps, HDR, luces agrupadas por tiles o clusters y sombras con límites de actualización. | Imágenes de referencia y tiempo/memoria por pase en escenas con muchas luces y materiales. |
| Temporal | Transformaciones anteriores, vectores de movimiento, jitter y tratamiento de transparencias/disoclusiones. | Estabilidad en movimiento, cambios de cámara y materiales; coste y calidad frente a render nativo. |
| Streaming y grafo completo | Añadir allocator transitorio y nuevos pases al grafo; cargas asíncronas, residencia y presupuestos de memoria. | Sin recursos usados después de liberar, picos acotados y recuperación ante recursos ausentes. |
| Backend nativo | Mantener el contrato de escena sobre Vulkan/D3D12/Metal; elegir capacidades por dispositivo. | Paridad visual/funcional y mejora medida que justifique mantenimiento adicional. |

Para el cook offline, [meshoptimizer](https://github.com/zeux/meshoptimizer)
ofrece optimización, simplificación, cuantización, compresión y meshlets. Sus
[interfaces JavaScript/WASM](https://github.com/zeux/meshoptimizer/blob/master/js/README.md)
permiten preparar geometría desde herramientas Node. No es una dependencia
incorporada actualmente; su integración debe definir formato, versión,
atributos preservados y error aceptable. El runtime de NERVA sigue funcionando
en Node.js 18+ sin dependencias npm.

HZB descarta objetos ocultos a partir de profundidad jerárquica, pero debe ser
conservador frente a movimiento y disoclusiones. La
[documentación de oclusión GPU de Unity](https://docs.unity.com/en-us/engine/6000.3/manual/analysis/graphics-performance-profiling/in-urp/gpu-culling)
sirve como referencia de esa etapa; no está implementada por el actual test
de frustum.

La reconstrucción temporal permite elegir menor resolución interna cuando su
ahorro supera el coste de reconstruir la imagen. El
[SDK de AMD FSR Super Resolution](https://gpuopen.com/manuals/fsr_sdk/techniques/super-resolution-upscaler/)
documenta profundidad, vectores de movimiento e historia, además de memoria y
costes de integración. No basta con ampliar la textura de salida. El SDK no
está integrado en este backend WebGPU, y la generación de cuadros sería otra
etapa con evaluación propia de latencia y artefactos.

Las rutas forward con luces agrupadas y deferred se deben evaluar como
alternativas según la escena. Los reconstructores temporales deben compartir
un contrato de entrada y elegirse, evitando reconstruir la misma imagen varias
veces. Ray tracing, mesh shaders, bindless y aliasing nativo sólo se añaden donde
sus capacidades y mediciones lo justifiquen. La arquitectura común es el
contrato de datos y pases; cada combinación activa tiene su propio presupuesto.
