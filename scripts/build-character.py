"""Build Iria, an original, rigged maintenance technician for the NERVA demo.

Run: blender --background --python scripts/build-character.py -- --output assets/characters
No imported model, texture, or commercial character is used. Blender 4.3+.
"""
import argparse
import json
import math
import os
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector


args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--output", default="assets/characters")
parser.add_argument("--preview", action="store_true")
options = parser.parse_args(args)
OUTPUT = Path(options.output).resolve()
OUTPUT.mkdir(parents=True, exist_ok=True)
ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / "private" / "character"
PRIVATE.mkdir(parents=True, exist_ok=True)
random.seed(1047)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for data in bpy.data.meshes:
    if data.users == 0:
        bpy.data.meshes.remove(data)

MATERIALS = {}
PARTS = []


def material(name, color, roughness=0.65, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    principled = mat.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (*color, 1.0)
    principled.inputs["Roughness"].default_value = roughness
    principled.inputs["Metallic"].default_value = metallic
    mat.diffuse_color = (*color, 1.0)
    MATERIALS[name] = mat
    return name


material("Skin warm olive", (0.43, 0.265, 0.174), 0.56)
material("Skin crease", (0.235, 0.108, 0.075), 0.66)
material("Lip muted natural", (0.33, 0.145, 0.108), 0.53)
material("Eye ivory", (0.57, 0.61, 0.55), 0.2)
material("Iris muted hazel", (0.105, 0.081, 0.042), 0.25)
material("Pupil", (0.004, 0.005, 0.005), 0.16)
material("Hair charcoal", (0.014, 0.018, 0.019), 0.39)
material("Hair highlights", (0.032, 0.036, 0.035), 0.43)
material("Jacket navy", (0.045, 0.075, 0.092), 0.79)
material("Jacket worn panels", (0.065, 0.102, 0.112), 0.84)
material("Jacket seam", (0.087, 0.121, 0.123), 0.86)
material("Trousers olive", (0.100, 0.115, 0.081), 0.83)
material("Trousers panel", (0.130, 0.144, 0.096), 0.85)
material("Scarf rust", (0.245, 0.071, 0.042), 0.85)
material("Leather dark umber", (0.055, 0.041, 0.031), 0.72)
material("Boot rubber", (0.020, 0.024, 0.025), 0.87)
material("Hardware gunmetal", (0.12, 0.135, 0.125), 0.35, 0.75)
material("Hardware brushed brass", (0.32, 0.24, 0.096), 0.43, 0.65)
material("Medical tape", (0.41, 0.395, 0.285), 0.94)


def one(bone):
    return lambda point: {bone: 1.0}


def height_weights(chain):
    """A bounded two-bone blend, evaluated in rest coordinates."""
    def weights(point):
        z = point[2]
        if z <= chain[0][0]:
            return {chain[0][1]: 1.0}
        for (lower, a), (upper, b) in zip(chain, chain[1:]):
            if z <= upper:
                t = (z - lower) / (upper - lower)
                return {a: 1.0 - t, b: t}
        return {chain[-1][1]: 1.0}
    return weights


torso_weights = height_weights([
    (0.99, "pelvis"), (1.105, "spine"),
    (1.25, "spine_upper"), (1.39, "chest"),
])


def mesh(name, vertices, faces, mat, weight, uv=None):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(MATERIALS[mat])
    for poly in data.polygons:
        poly.use_smooth = True
    coords = obj.data.uv_layers.new(name="UVMap")
    if uv is None:
        uv = [(float(p[0]) * 2, float(p[2]) * 2) for p in vertices]
    for poly in data.polygons:
        poly_uv = [uv[data.loops[loop_index].vertex_index] for loop_index in poly.loop_indices]
        crosses_seam = max(p[0] for p in poly_uv) - min(p[0] for p in poly_uv) > 0.5
        for loop_index in poly.loop_indices:
            u, v = uv[data.loops[loop_index].vertex_index]
            coords.data[loop_index].uv = (u + (1 if crosses_seam and u < .5 else 0), v)
    groups = {}
    for index, point in enumerate(vertices):
        for bone, strength in weight(point).items():
            if strength <= 0:
                continue
            if bone not in groups:
                groups[bone] = obj.vertex_groups.new(name=bone)
            groups[bone].add([index], strength, "REPLACE")
    PARTS.append(obj)
    return obj


def rings(name, sections, mat, weight, sides=24, shape=None):
    """Closed elliptical section surface; no coincident polar ring vertices."""
    vertices, faces, uv = [], [], []
    for j, (x, y, z, rx, ry) in enumerate(sections):
        for i in range(sides):
            theta = 2 * math.pi * i / sides
            point = [x + rx * math.cos(theta), y + ry * math.sin(theta), z]
            if shape:
                point = shape(point, theta, j)
            vertices.append(point)
            uv.append((i / sides, j / max(1, len(sections) - 1)))
    for j in range(len(sections) - 1):
        for i in range(sides):
            a = j * sides + i
            b = j * sides + (i + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    # Center fans cap the sections without degenerate pole triangles.
    for j, flip in [(0, True), (len(sections) - 1, False)]:
        x, y, z, _, _ = sections[j]
        center = len(vertices)
        vertices.append((x, y, z))
        uv.append((0.5, j / max(1, len(sections) - 1)))
        for i in range(sides):
            a, b = j * sides + i, j * sides + (i + 1) % sides
            faces.append((center, b, a) if flip else (center, a, b))
    return mesh(name, vertices, faces, mat, weight, uv)


def ellipsoid(name, center, radii, mat, weight, sides=20, bands=10):
    cx, cy, cz = center
    rx, ry, rz = radii
    vertices, faces, uv = [(cx, cy, cz - rz)], [], [(0.5, 0)]
    for j in range(1, bands):
        phi = -math.pi / 2 + j * math.pi / bands
        for i in range(sides):
            theta = 2 * math.pi * i / sides
            vertices.append((cx + rx * math.cos(phi) * math.cos(theta),
                             cy + ry * math.cos(phi) * math.sin(theta),
                             cz + rz * math.sin(phi)))
            uv.append((i / sides, j / bands))
    top = len(vertices)
    vertices.append((cx, cy, cz + rz))
    uv.append((0.5, 1))
    for i in range(sides):
        faces.append((0, 1 + (i + 1) % sides, 1 + i))
    for j in range(bands - 2):
        for i in range(sides):
            a = 1 + j * sides + i
            b = 1 + j * sides + (i + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    last = 1 + (bands - 2) * sides
    for i in range(sides):
        faces.append((last + i, last + (i + 1) % sides, top))
    return mesh(name, vertices, faces, mat, weight, uv)


def tube(name, points, radius, mat, weight, sides=6, taper=None):
    vertices, faces, uv = [], [], []
    for j, point in enumerate(points):
        point = Vector(point)
        tangent = Vector(points[min(j + 1, len(points) - 1)]) - Vector(points[max(j - 1, 0)])
        tangent.normalize()
        ref = Vector((0, 1, 0)) if abs(tangent.y) < 0.95 else Vector((1, 0, 0))
        axis_a = tangent.cross(ref).normalized()
        axis_b = tangent.cross(axis_a).normalized()
        r = radius * (taper[j] if taper else 1)
        for i in range(sides):
            theta = 2 * math.pi * i / sides
            vertices.append(point + r * (math.cos(theta) * axis_a + math.sin(theta) * axis_b))
            uv.append((i / sides, j / max(1, len(points) - 1)))
    for j in range(len(points) - 1):
        for i in range(sides):
            a, b = j * sides + i, j * sides + (i + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    # Small seam/hair tubes stay open at their ends; there are no zero-area caps.
    return mesh(name, vertices, faces, mat, weight, uv)


def box(name, center, dimensions, mat, weight, bevel=0.008):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.scale = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new("Rounded manufactured edges", "BEVEL")
        # Clamping exactly at half a thin panel creates collapsed bevel faces.
        mod.width = min(bevel, min(dimensions) * .38)
        mod.segments = 3
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    # Apply location: every mesh is in a common rest coordinate system.
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.data.materials.append(MATERIALS[mat])
    for poly in obj.data.polygons:
        poly.use_smooth = True
    groups = {}
    for vertex in obj.data.vertices:
        for bone, strength in weight(vertex.co).items():
            if strength > 0:
                if bone not in groups:
                    groups[bone] = obj.vertex_groups.new(name=bone)
                groups[bone].add([vertex.index], strength, "REPLACE")
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name="UVMap")
    PARTS.append(obj)
    return obj


# An adult body with a work jacket, rather than armor-shaped geometric blocks.
rings("Jacket silhouette", [
    (0, 0.008, 0.956, 0.146, 0.105),
    (0, 0.007, 1.005, 0.147, 0.104),
    (0, 0.009, 1.084, 0.128, 0.096),
    (0, 0.005, 1.166, 0.131, 0.099),
    (0, 0.005, 1.259, 0.160, 0.108),
    (0, 0.007, 1.346, 0.182, 0.103),
    (0, 0.009, 1.409, 0.166, 0.090),
    (0, 0.011, 1.438, 0.112, 0.068),
], "Jacket navy", torso_weights, 32)

# Central closure and parallel stitching follow the front profile.
tube("Jacket zipper", [(0, -0.108, 0.986), (0, -0.098, 1.10),
                       (0, -0.107, 1.26), (0, -0.095, 1.37)],
     0.0027, "Hardware gunmetal", torso_weights, 6)
for x in [-0.007, 0.007]:
    tube("Closure stitch", [(x, -0.109, 0.99), (x, -0.101, 1.10),
                            (x, -0.109, 1.26), (x, -0.10, 1.37)],
         0.0009, "Jacket seam", torso_weights, 4)
box("Zipper pull", (0.004, -0.111, 1.339), (0.008, 0.005, 0.019),
    "Hardware brushed brass", torso_weights, 0.0015)

# Pockets have flaps, stitch outlines and a small original identification plate.
for side in [-1, 1]:
    x = side * 0.084
    box("Chest pocket", (x, -0.098, 1.287), (0.073, 0.015, 0.083),
        "Jacket worn panels", torso_weights, 0.007)
    box("Pocket folded flap", (x, -0.11, 1.320), (0.079, 0.009, 0.027),
        "Jacket navy", torso_weights, 0.004)
    tube("Pocket stitching", [(x - .028, -.113, 1.306), (x - .028, -.113, 1.25),
                              (x + .028, -.113, 1.25), (x + .028, -.113, 1.306)],
         .0008, "Jacket seam", torso_weights, 4)
box("Blank maintenance ID", (-.084, -.118, 1.282), (.041, .002, .014),
    "Medical tape", torso_weights, .001)
for dz in [0, .004]:
    box("ID stamped line", (-.084, -.1195, 1.279 + dz), (.029, .001, .001),
        "Leather dark umber", torso_weights, 0)

# Neck and folded scarf: an asymmetrical accessory, not a franchise costume.
rings("Neck", [(0, .012, 1.407, .044, .040), (0, .012, 1.486, .043, .039)],
      "Skin warm olive", one("neck"), 20)
rings("Scarf wrapped collar", [(0, .013, 1.420, .066, .053),
                                (0, .013, 1.443, .064, .054),
                                (0, .013, 1.461, .054, .046)],
      "Scarf rust", one("neck"), 28,
      lambda p, theta, j: [p[0], p[1] + .002 * math.sin(theta * 6 + j),
                           p[2] + .003 * math.sin(theta * 3 + j)])
mesh("Scarf uneven folded tail", [(-.019, -.057, 1.428), (.037, -.051, 1.428),
                                  (.055, -.116, 1.343), (.016, -.118, 1.326),
                                  (-.004, -.094, 1.375)],
     [(0, 1, 4), (1, 2, 4), (2, 3, 4), (4, 3, 0)], "Scarf rust", torso_weights)
tube("Scarf fold", [(.019, -.060, 1.429), (.032, -.099, 1.383), (.033, -.120, 1.339)],
     .0017, "Lip muted natural", torso_weights, 4)

# Sleeves, forearms, palms and separately shaped fingers.
for side, suffix in [(-1, "R"), (1, "L")]:
    arm_weights = height_weights([(1.125, "forearm." + suffix),
                                  (1.185, "upper_arm." + suffix)])
    ellipsoid("Rounded shoulder " + suffix, (side * .181, .008, 1.392),
              (.067, .063, .061), "Jacket navy", one("upper_arm." + suffix), 24, 10)
    rings("Continuous sleeve " + suffix, [
        (side * .181, .008, 1.421, .059, .058),
        (side * .205, .008, 1.375, .060, .057),
        (side * .235, .001, 1.282, .050, .049),
        (side * .260, -.005, 1.191, .046, .043),
        (side * .268, -.006, 1.146, .048, .041),
        (side * .281, -.012, 1.065, .038, .038),
        (side * .300, -.016, .967, .032, .032),
        (side * .303, -.016, .946, .032, .031),
    ], "Jacket navy", arm_weights, 20,
       lambda p, t, j: [p[0], p[1], p[2] + (0.002 * math.sin(t * 4 + j) if j in [3, 4, 6] else 0)])
    rings("Sleeve cuff " + suffix, [(side * .302, -.016, .945, .034, .033),
                                    (side * .301, -.015, .968, .034, .033)],
          "Jacket worn panels", one("forearm." + suffix), 20)
    tube("Sleeve outside seam " + suffix,
         [(side * .24, .016, 1.406), (side * .283, .02, 1.28),
          (side * .307, .015, 1.155), (side * .330, .0, .977)],
         .0009, "Jacket seam", arm_weights, 4)
    box("Elbow repair panel " + suffix, (side * .265, .035, 1.16),
        (.052, .01, .079), "Jacket worn panels", arm_weights, .012)
    hand = "hand." + suffix
    rings("Wrist " + suffix, [(side * .305, -.017, .932, .024, .023),
                              (side * .309, -.019, .953, .024, .023)],
          "Skin warm olive", one(hand), 16)
    ellipsoid("Palm " + suffix, (side * .311, -.020, .904), (.031, .023, .045),
              "Skin warm olive", one(hand), 16, 8)
    # Fingers curl gently and remain separate at their tips.
    for digit, (offset, length) in enumerate([(-.022, .041), (-.007, .054), (.008, .052), (.022, .041)]):
        x = side * (.31 + offset)
        z = .887 - .002 * digit
        tube("Finger %d %s" % (digit, suffix),
             [(x, -.018, z), (x, -.026, z - length * .43),
              (x, -.036, z - length * .76), (x, -.043, z - length)],
             .0072 if digit < 3 else .0064, "Skin warm olive", one(hand), 8,
             [1, .97, .91, .70])
        ellipsoid("Finger tip", (x, -.043, z - length), (.0052, .0053, .0059),
                  "Skin warm olive", one(hand), 8, 4)
    tube("Thumb " + suffix, [(side * .284, -.020, .919), (side * .274, -.042, .897),
                              (side * .275, -.057, .884)],
         .009, "Skin warm olive", one(hand), 8, [1, .85, .66])
    # A practical wrist-wrap on one hand, an unambiguous original design detail.
    if suffix == "L":
        rings("Wrist protective tape", [(side * .304, -.017, .932, .025, .024),
                                         (side * .306, -.018, .943, .025, .024)],
              "Medical tape", one(hand), 16)

# Trousers have a natural hip transition, articulation seams and utility pockets.
rings("Trouser hip", [(0, .010, .894, .062, .073), (0, .012, .945, .135, .100),
                       (0, .012, .972, .147, .104),
                       (0, .008, 1.002, .139, .098)],
      "Trousers olive", one("pelvis"), 28)
for side, suffix in [(-1, "R"), (1, "L")]:
    leg_weights = height_weights([(.465, "calf." + suffix), (.555, "thigh." + suffix)])
    x = side * .086
    rings("Continuous trouser leg " + suffix, [
        (x, .012, .965, .083, .088),
        (side * .093, .007, .879, .084, .087),
        (side * .096, -.005, .754, .073, .075),
        (side * .097, -.012, .623, .061, .066),
        (side * .098, -.020, .541, .055, .055),
        (side * .098, -.014, .486, .055, .059),
        (side * .098, .003, .393, .058, .055),
        (side * .098, .012, .269, .045, .043),
        (side * .098, .012, .177, .041, .038),
    ], "Trousers olive", leg_weights, 20,
       lambda p, t, j: [p[0], p[1], p[2] + (.003 * math.sin(t * 3 + j) if j in [3, 4, 5, 8] else 0)])
    tube("Outer leg seam " + suffix, [(side * .17, .014, .93), (side * .166, .007, .75),
                                     (side * .154, -.009, .52), (side * .147, .017, .28)],
         .001, "Trousers panel", leg_weights, 4)
    box("Knee articulated reinforcement " + suffix, (x, -.077, .526),
        (.079, .012, .095), "Trousers panel", leg_weights, .016)
    box("Cargo pocket " + suffix, (side * .160, .007, .772), (.018, .105, .114),
        "Trousers panel", one("thigh." + suffix), .009)
    box("Cargo flap " + suffix, (side * .171, .006, .812), (.009, .114, .026),
        "Trousers olive", one("thigh." + suffix), .004)
    foot = "foot." + suffix
    rings("Leather boot shaft " + suffix, [(x, .014, .08, .050, .056),
                                            (x, .014, .15, .052, .050),
                                            (x, .014, .22, .048, .046)],
          "Leather dark umber", one(foot), 20)
    ellipsoid("Leather boot toe " + suffix, (x, -.067, .070), (.055, .123, .061),
              "Leather dark umber", one(foot), 24, 8)
    box("Rubber sole " + suffix, (x, -.049, .026), (.114, .25, .038),
        "Boot rubber", one(foot), .015)
    box("Boot heel " + suffix, (x, .052, .039), (.093, .070, .044),
        "Boot rubber", one(foot), .008)
    for j in range(5):
        z = .105 + j * .018
        y = -.048 + j * .004
        tube("Boot lace " + suffix, [(x - .025, y, z), (x + .022, y - .006, z + .012)],
             .0016, "Medical tape", one(foot), 5)

# Utility belt and a diagonal harness follow the torso; no weapon or franchise emblems.
rings("Utility belt", [(0, .008, .990, .149, .106), (0, .008, 1.020, .145, .106)],
      "Leather dark umber", one("pelvis"), 32)
box("Belt buckle", (.020, -.103, 1.004), (.041, .017, .035),
    "Hardware gunmetal", one("pelvis"), .004)
for side in [-1, 1]:
    box("Belt pouch", (side * .121, -.075, .972), (.068, .052, .098),
        "Leather dark umber", one("pelvis"), .009)
    box("Pouch flap", (side * .121, -.107, 1.002), (.070, .008, .039),
        "Leather dark umber", one("pelvis"), .004)
    ellipsoid("Pouch rivet", (side * .121, -.114, .995), (.003, .002, .003),
              "Hardware brushed brass", one("pelvis"), 8, 4)
harness_points = [(-.122, -.073, 1.018), (-.095, -.109, 1.10),
                  (-.032, -.121, 1.22), (.052, -.103, 1.34), (.119, -.064, 1.414)]
for delta in [-.007, .007]:
    tube("Harness raised edge", [(x + delta, y, z) for x, y, z in harness_points],
         .0042, "Leather dark umber", torso_weights, 6)
mesh("Harness woven strap", [(x - .011, y - .001, z) for x, y, z in harness_points] +
                             [(x + .011, y - .001, z) for x, y, z in harness_points],
     [(i, i + 1, i + 6, i + 5) for i in range(4)],
     "Leather dark umber", torso_weights)
box("Harness adjuster", (-.025, -.128, 1.228), (.032, .008, .028),
    "Hardware gunmetal", torso_weights, .003)
box("Maintenance meter", (-.160, -.030, 1.027), (.044, .053, .064),
    "Jacket worn panels", one("pelvis"), .004)
box("Meter inset screen", (-.164, -.059, 1.033), (.025, .002, .026),
    "Hardware gunmetal", one("pelvis"), .001)

# Head sections: cheekbones, jaw, chin, temples and cranium, not a UV sphere face.
def head_shape(point, theta, j):
    # The face is -Y in Blender; exported glTF uses +Z as its forward axis.
    front = max(0.0, -math.sin(theta))
    cheek = math.exp(-((point[2] - 1.573) / .027) ** 2)
    point[1] -= .006 * cheek * front
    return point

head_surface = rings("Anatomical head", [
    (0, -.014, 1.483, .023, .028),
    (0, -.009, 1.501, .038, .042),
    (0, -.005, 1.524, .052, .047),
    (0, .003, 1.550, .064, .057),
    (0, .008, 1.576, .071, .066),
    (0, .012, 1.600, .074, .069),
    (0, .016, 1.625, .073, .070),
    (0, .021, 1.650, .067, .069),
    (0, .021, 1.678, .052, .058),
    (0, .021, 1.699, .030, .036),
    (0, .021, 1.708, .005, .008),
], "Skin warm olive", one("head"), 40, head_shape)
head_subdivision = head_surface.modifiers.new("Smoothed anatomical sections", "SUBSURF")
head_subdivision.levels = 1
bpy.context.view_layer.objects.active = head_surface
bpy.ops.object.modifier_apply(modifier=head_subdivision.name)

# The nose bridge is a shaped surface with nostril wings and a distinct tip.
rings("Nose bridge", [(0, -.064, 1.550, .012, .008),
                       (0, -.078, 1.560, .012, .013),
                       (0, -.079, 1.572, .010, .015),
                       (0, -.064, 1.599, .007, .009),
                       (0, -.058, 1.611, .004, .003)],
      "Skin warm olive", one("head"), 16)
ellipsoid("Nose tip", (0, -.084, 1.568), (.012, .012, .010),
          "Skin warm olive", one("head"), 16, 6)
for side in [-1, 1]:
    ellipsoid("Nostril wing", (side * .010, -.075, 1.558), (.008, .008, .0055),
              "Skin warm olive", one("head"), 12, 6)
    ellipsoid("Nostril crease", (side * .008, -.081, 1.554), (.004, .002, .0015),
              "Skin crease", one("head"), 10, 4)

# Small eyes sit inside lids; the whites are exposed only in the almond opening.
for side in [-1, 1]:
    x, y, z = side * .028, -.0595, 1.598
    ellipsoid("Eye sclera", (x, y, z), (.0155, .0072, .0065),
              "Eye ivory", one("head"), 20, 8)
    ellipsoid("Iris", (x, y - .0067, z), (.0047, .0013, .0047),
              "Iris muted hazel", one("head"), 16, 6)
    ellipsoid("Pupil", (x, y - .0078, z), (.002, .0009, .0022),
              "Pupil", one("head"), 12, 6)
    upper = [(x - .015, y -.001, z), (x -.009, y -.004, z + .0054),
             (x, y -.0057, z + .0062), (x + .009, y -.004, z + .0043),
             (x + .015, y -.001, z)]
    lower = [(x -.015, y -.001, z), (x -.007, y -.005, z -.0048),
             (x + .005, y -.005, z -.005), (x + .015, y -.001, z)]
    tube("Upper eyelid", upper, .0022, "Skin warm olive", one("head"), 6)
    tube("Lower eyelid", lower, .0016, "Skin warm olive", one("head"), 6)
    tube("Upper lash line", [(a, b -.001, c -.0007) for a, b, c in upper],
         .0006, "Hair charcoal", one("head"), 4)
    tube("Natural eyebrow", [(x -.017, -.056, 1.615), (x -.006, -.060, 1.618),
                              (x + .006, -.060, 1.618), (x + .016, -.055, 1.614)],
         .0022, "Hair charcoal", one("head"), 6, [.55, 1, .85, .35])
    ellipsoid("Ear", (side * .073, .014, 1.583), (.012, .010, .025),
              "Skin warm olive", one("head"), 16, 8)
    ellipsoid("Ear inner fold", (side * .080, .006, 1.582), (.0045, .007, .014),
              "Skin crease", one("head"), 12, 6)
    tube("Ear helix", [(side * .080, .015, 1.562), (side * .082, .006, 1.570),
                       (side * .082, .007, 1.596), (side * .080, .015, 1.604)],
         .0024, "Skin warm olive", one("head"), 6)

tube("Upper lip", [(-.018, -.053, 1.535), (-.008, -.059, 1.537),
                   (0, -.059, 1.5355), (.007, -.058, 1.537), (.018, -.052, 1.535)],
     .0025, "Lip muted natural", one("head"), 8, [.5, 1, .85, 1, .5])
tube("Mouth line", [(-.016, -.055, 1.5335), (0, -.061, 1.533), (.016, -.054, 1.5335)],
     .0009, "Skin crease", one("head"), 5)
tube("Lower lip", [(-.016, -.053, 1.532), (0, -.059, 1.530), (.016, -.052, 1.532)],
     .0028, "Lip muted natural", one("head"), 8, [.4, 1, .4])

# A short, asymmetric charcoal crop. Its open lower rim has no scalp-like polar seam.
vertices, faces, uv = [], [], []
segments, rows = 40, 10
for j in range(rows):
    amount = j / (rows - 1)
    for i in range(segments):
        theta = 2 * math.pi * i / segments
        front = max(0, -math.sin(theta))
        bottom = 1.546 + front * .094 + max(0, math.cos(theta)) * front * .018
        z = 1.714 - (1.714 - bottom) * amount
        u = (z - 1.622) / .101
        radial = math.sqrt(max(.03, 1 - min(.985, abs(u)) ** 2))
        x = .080 * radial * math.cos(theta)
        y = .024 + .083 * radial * math.sin(theta)
        x += .004 * math.sin(theta * 5) * amount
        vertices.append((x, y, z))
        uv.append((i / segments, amount))
for j in range(rows - 1):
    for i in range(segments):
        a, b = j * segments + i, j * segments + (i + 1) % segments
        faces.append((a, a + segments, b + segments, b))
top = len(vertices)
vertices.append((0, .024, 1.719))
uv.append((.5, 0))
for i in range(segments):
    faces.append((top, i, (i + 1) % segments))
mesh("Asymmetric cropped hair", vertices, faces, "Hair charcoal", one("head"), uv)

# Sparse curved locks give broad highlights; no thousands of hair cards or alpha sorting.
for i in range(22):
    theta = 2 * math.pi * i / 22
    points = []
    for j in range(5):
        t = j / 4
        angle = theta + .30 * (1 - t)
        phi = .18 + t * (1.65 if math.sin(theta) > 0 else 1.00)
        points.append((.081 * math.sin(phi) * math.cos(angle),
                       .024 + .085 * math.sin(phi) * math.sin(angle),
                       1.620 + .101 * math.cos(phi)))
    tube("Sculpted hair lock", points, .0013, "Hair highlights", one("head"), 4,
         [.55, 1, 1, .85, .30])
# The swept fringe lies above the forehead and deliberately exposes one brow.
for i in range(7):
    x = -.054 + i * .009
    tube("Swept fringe", [(x + .047, -.020, 1.703), (x + .025, -.054, 1.675),
                          (x + .006, -.070, 1.651), (x -.008, -.061, 1.630 + .002 * i)],
         .0061, "Hair charcoal", one("head"), 6, [1.1, 1.15, .85, .22])

# Combine all surfaces into one skinned mesh with material-indexed glTF primitives.
bpy.ops.object.select_all(action="DESELECT")
for obj in PARTS:
    obj.select_set(True)
bpy.context.view_layer.objects.active = PARTS[0]
bpy.ops.object.join()
body = bpy.context.object
body.name = "Iria_SkinnedMesh"
triangulate = body.modifiers.new("Explicit triangle topology", "TRIANGULATE")
bpy.ops.object.modifier_apply(modifier=triangulate.name)

# Humanoid rig: 23 deform joints, blended elbows, knees and torso.
armature_data = bpy.data.armatures.new("Iria_Humanoid23")
rig = bpy.data.objects.new("Iria_Rig", armature_data)
bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
body.select_set(False)
rig.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
BONES = {}


def bone(name, head, tail, parent=None):
    joint = armature_data.edit_bones.new(name)
    joint.head, joint.tail = head, tail
    if parent:
        joint.parent = BONES[parent]
    BONES[name] = joint
    return joint


bone("root", (0, 0, 0), (0, 0, .20))
bone("pelvis", (0, .01, .93), (0, .01, 1.025), "root")
bone("spine", (0, .01, 1.025), (0, .01, 1.16), "pelvis")
bone("spine_upper", (0, .01, 1.16), (0, .01, 1.30), "spine")
bone("chest", (0, .01, 1.30), (0, .012, 1.43), "spine_upper")
bone("neck", (0, .012, 1.43), (0, .012, 1.493), "chest")
bone("head", (0, .012, 1.493), (0, .017, 1.705), "neck")
for side, suffix in [(-1, "R"), (1, "L")]:
    bone("clavicle." + suffix, (0, .011, 1.398), (side * .181, .008, 1.413), "chest")
    bone("upper_arm." + suffix, (side * .181, .008, 1.413), (side * .265, -.006, 1.161), "clavicle." + suffix)
    bone("forearm." + suffix, (side * .265, -.006, 1.161), (side * .303, -.016, .951), "upper_arm." + suffix)
    bone("hand." + suffix, (side * .303, -.016, .951), (side * .311, -.026, .867), "forearm." + suffix)
    bone("thigh." + suffix, (side * .086, .012, .94), (side * .098, -.02, .514), "pelvis")
    bone("calf." + suffix, (side * .098, -.02, .514), (side * .098, .014, .115), "thigh." + suffix)
    bone("foot." + suffix, (side * .098, .014, .115), (side * .098, -.124, .057), "calf." + suffix)
    bone("toe." + suffix, (side * .098, -.124, .057), (side * .098, -.184, .042), "foot." + suffix)
bpy.ops.object.mode_set(mode="OBJECT")
rig.show_in_front = True
body.parent = rig
modifier = body.modifiers.new("Humanoid skin deformation", "ARMATURE")
modifier.object = rig
modifier.use_vertex_groups = True
body["original_design"] = "Iria: maintenance technician, no imported character assets"
body["metres_height"] = 1.72
rig["humanoid_joint_count"] = 23

# Both animations use TRS channels on joints, never mesh-frame snapshots.
scene = bpy.context.scene
scene.render.fps = 30


def animation(name, length, gait):
    action = bpy.data.actions.new(name)
    rig.animation_data_create()
    rig.animation_data.action = action
    for pose in rig.pose.bones:
        pose.rotation_mode = "QUATERNION"
    frames = list(range(0, length + 1, 3))
    if frames[-1] != length:
        frames.append(length)
    for frame in frames:
        phase = 2 * math.pi * frame / length
        for pose in rig.pose.bones:
            pose.rotation_quaternion = (1, 0, 0, 0)
            pose.location = (0, 0, 0)
            pose.scale = (1, 1, 1)
        from mathutils import Quaternion
        if gait:
            # Root local Y follows its vertical rest bone; this is world Z in Blender.
            rig.pose.bones["root"].location.y = .006 * (1 - math.cos(2 * phase))
            rig.pose.bones["pelvis"].rotation_quaternion = Quaternion((0, 1, 0), .023 * math.sin(phase))
            rig.pose.bones["chest"].rotation_quaternion = Quaternion((0, 1, 0), -.027 * math.sin(phase))
            for suffix, sign in [("L", 1), ("R", -1)]:
                swing = sign * math.sin(phase)
                rig.pose.bones["thigh." + suffix].rotation_quaternion = Quaternion((1, 0, 0), .34 * swing)
                rig.pose.bones["calf." + suffix].rotation_quaternion = Quaternion((1, 0, 0), -.32 * max(0, -swing))
                rig.pose.bones["foot." + suffix].rotation_quaternion = Quaternion((1, 0, 0), -.11 * swing)
                rig.pose.bones["upper_arm." + suffix].rotation_quaternion = Quaternion((1, 0, 0), -.22 * swing)
                rig.pose.bones["forearm." + suffix].rotation_quaternion = Quaternion((1, 0, 0), -.08 - .045 * swing)
            rig.pose.bones["head"].rotation_quaternion = Quaternion((0, 1, 0), .012 * math.sin(phase))
        else:
            rig.pose.bones["root"].rotation_quaternion = Quaternion((0, 1, 0), .007 * math.sin(phase))
            rig.pose.bones["chest"].rotation_quaternion = Quaternion((1, 0, 0), .007 * math.sin(phase))
            rig.pose.bones["chest"].scale = (1 + .0015 * math.sin(phase), 1 + .003 * math.sin(phase), 1)
            rig.pose.bones["head"].rotation_quaternion = Quaternion((0, 1, 0), .018 * math.sin(phase * 1.0))
            for suffix, sign in [("L", 1), ("R", -1)]:
                rig.pose.bones["upper_arm." + suffix].rotation_quaternion = Quaternion((1, 0, 0), .01 * sign * math.sin(phase))
                rig.pose.bones["forearm." + suffix].rotation_quaternion = Quaternion((1, 0, 0), -.035 + .005 * math.sin(phase))
        for pose in rig.pose.bones:
            pose.keyframe_insert(data_path="rotation_quaternion", frame=frame)
            if pose.name == "root":
                pose.keyframe_insert(data_path="location", frame=frame)
            if pose.name == "chest" and not gait:
                pose.keyframe_insert(data_path="scale", frame=frame)
    for fcurve in action.fcurves:
        for key in fcurve.keyframe_points:
            key.interpolation = "LINEAR"
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, action)
    rig.animation_data.action = None
    return action


animation("Idle", 72, False)
animation("Walk", 33, True)
scene.frame_set(0)
scene.frame_start, scene.frame_end = 0, 72
for pose in rig.pose.bones:
    pose.rotation_quaternion = (1, 0, 0, 0)
    pose.location = (0, 0, 0)
    pose.scale = (1, 1, 1)

# glTF 2.0 export: separate binary, no image textures, no Draco, no sparse accessor.
bpy.ops.object.select_all(action="DESELECT")
rig.select_set(True)
body.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(
    filepath=str(OUTPUT / "iria.gltf"), export_format="GLTF_SEPARATE",
    use_selection=True, export_yup=True, export_animations=True,
    export_animation_mode="NLA_TRACKS", export_force_sampling=True,
    export_frame_step=3, export_skins=True, export_all_influences=False,
    export_def_bones=False, export_normals=True, export_texcoords=True,
    export_materials="EXPORT", export_extras=True,
)

# A reproducible source blend is kept private; only glTF+bin are repository assets.
bpy.ops.wm.save_as_mainfile(filepath=str(PRIVATE / "iria.blend"))
document = json.loads((OUTPUT / "iria.gltf").read_text())
triangles = sum(document["accessors"][primitive["indices"]]["count"] // 3
                for obj in document.get("meshes", []) for primitive in obj["primitives"])
stats = {
    "name": "Iria", "original": True, "heightMetres": 1.72,
    "triangles": triangles,
    "joints": [len(skin["joints"]) for skin in document.get("skins", [])],
    "animations": [{"name": clip.get("name"), "channels": len(clip["channels"])}
                   for clip in document.get("animations", [])],
    "gltfBytes": (OUTPUT / "iria.gltf").stat().st_size,
    "binaryBytes": (OUTPUT / "iria.bin").stat().st_size,
}
(PRIVATE / "build-report.json").write_text(json.dumps(stats, indent=2) + "\n")
print("IRIA_BUILD", json.dumps(stats))

if options.preview:
    # This authoring render is a shape review, never evidence of the WebGPU engine.
    for track in rig.animation_data.nla_tracks:
        track.mute = True
    rig.animation_data.action = None
    for pose in rig.pose.bones:
        pose.rotation_quaternion = (1, 0, 0, 0)
        pose.location = (0, 0, 0)
        pose.scale = (1, 1, 1)
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -.003))
    ground = bpy.context.object
    ground.data.materials.append(MATERIALS["Jacket navy"])
    for name, location, energy, size in [
        ("Key", (-2.3, -3.0, 4.0), 650, 4.0),
        ("Rim", (2.0, 1.3, 2.8), 780, 3.0),
        ("Fill", (2.0, -2.0, 1.9), 190, 2.0),
    ]:
        data = bpy.data.lights.new(name, "AREA")
        data.energy, data.shape, data.size = energy, "DISK", size
        obj = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(obj)
        obj.location = location
        obj.rotation_euler = (Vector((0, 0, 1)) - obj.location).to_track_quat("-Z", "Y").to_euler()
    camera = bpy.data.cameras.new("Authoring review camera")
    camera_obj = bpy.data.objects.new("Authoring review camera", camera)
    bpy.context.collection.objects.link(camera_obj)
    camera_obj.location = (2.1, -4.0, 1.84)
    camera_obj.rotation_euler = (Vector((0, 0, .91)) - camera_obj.location).to_track_quat("-Z", "Y").to_euler()
    camera.lens = 65
    scene.camera = camera_obj
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x, scene.render.resolution_y = 900, 1100
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.world.color = (.11, .11, .11)
    scene.render.filepath = str(PRIVATE / "iria-authoring-review.png")
    bpy.ops.render.render(write_still=True)
