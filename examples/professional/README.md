# Facturación modular en NERVA 0.3

Ejemplo ejecutable con datos sintéticos. Separa cálculo y validación en un módulo,
recibe pedidos JSON y emite un reporte estructurado. La política de descuentos,
impuestos y redondeo se define explícitamente en el módulo del ejemplo.

Desde la raíz del repositorio:

```sh
node src/nerva.mjs run examples/professional/main.nv --inputs examples/professional/input.json --json
node src/nerva.mjs test examples/professional --root examples/professional --json
```

El lote de ejemplo suma **51993 centavos**: subtotal `51097`, descuentos `5500`,
base neta `45597` e impuestos `6396`. Contiene dos facturas denominadas en EUR.

Los importes usan centavos enteros. `tax_bps` y `discount_bps` usan puntos básicos:
`2100` representa un 21 % y `10000` un 100 %. Para cada línea se calcula primero
el descuento sobre `quantity * unit_price_cents`, se redondea al centavo más
cercano y después se calcula y redondea el impuesto sobre la base descontada.
Las mitades positivas se redondean hacia arriba. Los totales suman las líneas ya
redondeadas; otras políticas fiscales requieren cambiar esta regla explícita.

La validación comprueba campos necesarios, cantidades positivas enteras, precios
no negativos enteros, porcentajes entre 0 y 10000, facturas no vacías, identificadores
duplicados y monedas coherentes. Los valores numéricos con un tipo JSON incorrecto
producen errores del runtime. Cada factura admite hasta 1000 líneas y cada lote
hasta 100 facturas. El subtotal por línea se acota a 1000000000 centavos para
conservar intermediarios y sumas dentro del rango entero seguro del motor.
Los presupuestos de ejecución de NERVA siguen aplicándose.

Las pruebas `.test.nv` comprueban importes calculados, redondeos en medio centavo,
descuentos completos, rechazo de datos inválidos, persistencia de colecciones y
serialización JSON. No requieren ejecutar `main.nv` ni cargar entradas externas.
