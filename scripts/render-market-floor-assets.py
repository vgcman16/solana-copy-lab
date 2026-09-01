import bpy
import math
import os
import shutil
import subprocess
import sys
from mathutils import Vector


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUTPUT = os.environ.get("COPYLAB_ASSET_OUTPUT") or os.path.join(
    ROOT,
    "apps",
    "web",
    "public",
    "assets",
)
ENCODER = os.path.join(ROOT, "scripts", "encode-animation-webp.py")
APNG_ENCODER = os.path.join(ROOT, "scripts", "encode-animation-apng.py")
PYTHON = (
    os.environ.get("COPYLAB_PYTHON")
    or shutil.which("python")
    or shutil.which("python3")
    or ""
)
os.makedirs(OUTPUT, exist_ok=True)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for data in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for block in list(data):
            if block.users == 0:
                data.remove(block)


def material(name, color, metallic=0.0, roughness=0.35, emission=None, emission_strength=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def add_box(name, location, scale, mat, bevel=0.12):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    modifier = obj.modifiers.new("Soft industrial edges", "BEVEL")
    modifier.width = bevel
    modifier.segments = 5
    obj.data.materials.append(mat)
    return obj


def add_prism(name, polygon, center_z, height, mat, bevel=0.12):
    bottom_z = center_z - height / 2
    top_z = center_z + height / 2
    vertices = [(x, y, bottom_z) for x, y in polygon] + [(x, y, top_z) for x, y in polygon]
    count = len(polygon)
    faces = [
        tuple(reversed(range(count))),
        tuple(range(count, count * 2)),
    ]
    for index in range(count):
        next_index = (index + 1) % count
        faces.append((index, next_index, next_index + count, index + count))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    modifier = obj.modifiers.new("Soft industrial edges", "BEVEL")
    modifier.width = bevel
    modifier.segments = 5
    obj.data.materials.append(mat)
    return obj


def add_cylinder(name, vertices, radius, depth, location, mat, bevel=0.05, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    modifier = obj.modifiers.new("Beveled edge", "BEVEL")
    modifier.width = bevel
    modifier.segments = 4
    obj.data.materials.append(mat)
    return obj


def add_emissive_curve(name, points, mat, bevel_depth=0.02):
    curve_data = bpy.data.curves.new(name, "CURVE")
    curve_data.dimensions = "3D"
    curve_data.bevel_depth = bevel_depth
    curve_data.bevel_resolution = 4
    spline = curve_data.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for point, coordinates in zip(spline.bezier_points, points):
        point.co = coordinates
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, curve_data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def point_camera(camera, target):
    direction = Vector(target) - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def add_area_light(name, location, energy, color, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.color = color
    data.shape = "DISK"
    data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    point_camera(obj, (0, 0, 0))
    return obj


def configure_render(width, height, transparent=True):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = transparent
    scene.render.image_settings.color_depth = "8"
    scene.render.resolution_percentage = 100
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.render.use_file_extension = True


def render_animation_to_webp(name, frame_end, fps=24, transparent=False):
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = frame_end
    scene.render.fps = fps
    scene.render.film_transparent = transparent
    scene.world.color = (0.0, 0.0, 0.0)
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA" if transparent else "RGB"
    frame_directory = os.path.join(OUTPUT, f".{name}-frames")
    if os.path.isdir(frame_directory):
        shutil.rmtree(frame_directory)
    os.makedirs(frame_directory, exist_ok=True)
    scene.render.filepath = os.path.join(frame_directory, "frame_")
    bpy.ops.render.render(animation=True)
    if not os.path.isfile(PYTHON):
        raise RuntimeError("Python was not found. Set COPYLAB_PYTHON to a Python executable.")
    output_path = os.path.join(OUTPUT, f"{name}.webp")
    subprocess.run([
        PYTHON,
        ENCODER,
        frame_directory,
        output_path,
        "--fps",
        str(fps),
        "--loop",
        "1" if transparent else "0",
        "--cleanup",
    ], check=True)


def render_animation_to_apng(name, frame_end, fps=24):
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = frame_end
    scene.render.fps = fps
    scene.render.film_transparent = True
    scene.world.color = (0.0, 0.0, 0.0)
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    frame_directory = os.path.join(OUTPUT, f".{name}-frames")
    if os.path.isdir(frame_directory):
        shutil.rmtree(frame_directory)
    os.makedirs(frame_directory, exist_ok=True)
    scene.render.filepath = os.path.join(frame_directory, "frame_")
    bpy.ops.render.render(animation=True)
    if not os.path.isfile(PYTHON):
        raise RuntimeError("Python was not found. Set COPYLAB_PYTHON to a Python executable.")
    output_path = os.path.join(OUTPUT, f"{name}.png")
    subprocess.run([
        PYTHON,
        APNG_ENCODER,
        frame_directory,
        output_path,
        "--fps",
        str(fps),
        "--cleanup",
    ], check=True)


def animate_emission(mat, frames):
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    strength = bsdf.inputs["Emission Strength"]
    for frame, value in frames:
        strength.default_value = value
        strength.keyframe_insert(data_path="default_value", frame=frame)


def quadratic_point(start, bend, end, t):
    p0 = Vector(start)
    p1 = Vector(bend)
    p2 = Vector(end)
    return (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2


def add_animated_packet(name, start, bend, end, mat, phase, frame_end, radius=0.085):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=radius, location=start)
    packet = bpy.context.object
    packet.name = name
    packet.data.materials.append(mat)
    for frame in range(1, frame_end + 2, 3):
        t = (((frame - 1) / frame_end) + phase) % 1.0
        packet.location = quadratic_point(start, bend, end, t)
        visibility = max(0.0, math.sin(math.pi * t))
        scale = 0.25 + visibility * 0.9
        packet.scale = (scale, scale, scale)
        packet.keyframe_insert(data_path="location", frame=frame)
        packet.keyframe_insert(data_path="scale", frame=frame)
    return packet


def render_platform(include_animation=True):
    clear_scene()
    configure_render(1600, 420)
    floor = material("Recessed floor", (0.004, 0.016, 0.024), 0.5, 0.5)
    grid = material(
        "Floor grid",
        (0.015, 0.075, 0.095),
        0.1,
        0.5,
        emission=(0.03, 0.19, 0.24),
        emission_strength=0.18,
    )
    dark = material("Black anodized metal", (0.012, 0.033, 0.046), 0.7, 0.36)
    lower_metal = material("Lower blue steel face", (0.018, 0.052, 0.068), 0.82, 0.34)
    edge = material("Raised blue steel deck", (0.035, 0.095, 0.12), 0.76, 0.31)
    top_deck = material("Upper blue steel deck", (0.035, 0.09, 0.12), 0.72, 0.32)
    bright_edge = material("Silver blue bevel", (0.12, 0.22, 0.25), 0.76, 0.27)
    cyan = material(
        "Cyan edge light",
        (0.008, 0.17, 0.24),
        0.2,
        0.22,
        emission=(0.06, 0.56, 0.78),
        emission_strength=0.48,
    )
    green = material(
        "Green status light",
        (0.18, 0.42, 0.05),
        0.15,
        0.18,
        emission=(0.55, 1.0, 0.22),
        emission_strength=2.8,
    )

    add_box("Recessed holographic floor", (0, 0.25, -0.9), (8.4, 4.5, 0.035), floor, 0.05)
    for x in (-6.0, -4.5, -3.0, -1.5, 0.0, 1.5, 3.0, 4.5, 6.0):
        add_box(f"Floor depth line {x}", (x, -0.35, -0.85), (0.012, 3.7, 0.006), grid, 0.005)
    for y in (-3.5, -2.6, -1.7, -0.8, 0.1, 1.0, 1.9):
        add_box(f"Floor cross line {y}", (0, y, -0.85), (7.8, 0.012, 0.006), grid, 0.005)

    lower = [(-6.95, 2.25), (6.95, 2.25), (7.75, -1.3), (7.25, -2.42), (-7.25, -2.42), (-7.75, -1.3)]
    middle = [(-6.4, 1.98), (6.4, 1.98), (7.18, -1.18), (6.77, -2.08), (-6.77, -2.08), (-7.18, -1.18)]
    upper = [(-5.8, 1.68), (5.8, 1.68), (6.58, -1.02), (6.18, -1.78), (-6.18, -1.78), (-6.58, -1.02)]
    add_prism("Lower podium", lower, -0.31, 0.74, lower_metal, 0.075)
    add_prism("Middle podium", middle, 0.12, 0.18, edge, 0.04)
    add_prism("Upper strategy deck", upper, 0.31, 0.15, top_deck, 0.04)
    add_box("Front metal bevel", (0, -2.53, 0.015), (6.72, 0.035, 0.034), bright_edge, 0.014)
    add_box("Front cyan rim", (0, -2.58, -0.025), (6.46, 0.012, 0.011), cyan, 0.008)
    add_box("Active card metal plinth", (0, -1.72, 0.49), (2.38, 0.055, 0.045), bright_edge, 0.018)
    add_box("Active card cyan plinth", (0, -1.78, 0.43), (2.2, 0.012, 0.011), cyan, 0.008)
    add_box("Lower step", (0, -2.79, -0.68), (3.25, 0.28, 0.11), dark, 0.09)
    add_box("Lower step face", (0, -3.09, -0.64), (3.02, 0.02, 0.02), bright_edge, 0.009)
    for index, x in enumerate((0.55, 0.95, 1.35, 1.75, 2.15)):
        add_box(f"Lower status segment {index}", (x, -3.13, -0.62), (0.14, 0.011, 0.011), bright_edge, 0.006)
    add_box("Center status", (-0.18, -3.16, -0.61), (0.16, 0.02, 0.02), green, 0.01)

    camera_data = bpy.data.cameras.new("Market Floor Camera")
    camera = bpy.data.objects.new("Market Floor Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    camera.location = (0, -19.5, 7.2)
    camera_data.lens = 48
    point_camera(camera, (0, 0.1, -0.08))

    add_area_light("Cool key", (-5.5, -7.0, 7.0), 650, (0.25, 0.72, 1.0), 7)
    add_area_light("Green fill", (4.5, -5.0, 4.0), 70, (0.48, 1.0, 0.2), 5)
    add_area_light("Top rim", (0, 2.5, 7.5), 690, (0.42, 0.76, 0.92), 8)
    add_area_light("Front bevel light", (0, -8.5, 1.25), 470, (0.48, 0.80, 1.0), 9)
    add_area_light("Front face fill", (0, -5.0, -0.4), 260, (0.18, 0.48, 0.62), 10)

    bpy.context.scene.render.filepath = os.path.join(OUTPUT, "market-floor-platform.png")
    bpy.ops.render.render(write_still=True)

    if include_animation:
        frame_end = 48
        animate_emission(cyan, [
            (1, 0.35),
            (12, 0.72),
            (24, 0.42),
            (36, 0.82),
            (49, 0.35),
        ])
        animate_emission(green, [
            (1, 1.8),
            (12, 3.8),
            (24, 2.0),
            (36, 4.2),
            (49, 1.8),
        ])
        render_animation_to_webp("market-floor-platform-loop", frame_end)


def render_chart_platform():
    clear_scene()
    configure_render(1600, 260)
    floor = material("Chart recessed floor", (0.006, 0.018, 0.026), 0.48, 0.48)
    deck = material("Chart deck", (0.012, 0.038, 0.052), 0.66, 0.36)
    bevel = material("Chart silver bevel", (0.075, 0.13, 0.15), 0.72, 0.3)
    grid = material(
        "Chart floor grid",
        (0.012, 0.07, 0.095),
        0.1,
        0.48,
        emission=(0.03, 0.22, 0.29),
        emission_strength=0.24,
    )
    cyan = material(
        "Chart cyan rim",
        (0.006, 0.16, 0.23),
        0.18,
        0.24,
        emission=(0.05, 0.52, 0.78),
        emission_strength=0.58,
    )
    add_box("Chart floor", (0, 0.5, -0.46), (8.5, 4.5, 0.035), floor, 0.05)
    for x in (-7.0, -5.25, -3.5, -1.75, 0.0, 1.75, 3.5, 5.25, 7.0):
        add_box(f"Chart depth line {x}", (x, -0.1, -0.41), (0.01, 3.8, 0.005), grid, 0.004)
    for y in (-3.5, -2.6, -1.7, -0.8, 0.1, 1.0, 1.9):
        add_box(f"Chart cross line {y}", (0, y, -0.41), (8.0, 0.01, 0.005), grid, 0.004)
    polygon = [(-7.6, 1.0), (7.6, 1.0), (8.1, -1.4), (7.65, -2.05), (-7.65, -2.05), (-8.1, -1.4)]
    add_prism("Chart platform", polygon, -0.15, 0.2, deck, 0.06)
    add_box("Chart front bevel", (0, -2.0, -0.12), (7.55, 0.035, 0.028), bevel, 0.014)
    add_box("Chart front cyan rim", (0, -2.055, -0.15), (7.35, 0.01, 0.01), cyan, 0.006)

    camera_data = bpy.data.cameras.new("Chart Platform Camera")
    camera = bpy.data.objects.new("Chart Platform Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    camera.location = (0, -15.8, 5.3)
    camera_data.lens = 48
    point_camera(camera, (0, 0.0, -0.35))
    add_area_light("Chart top rim", (0, 2.5, 7.0), 410, (0.35, 0.68, 0.86), 8)
    add_area_light("Chart front light", (0, -8.0, 2.0), 250, (0.38, 0.72, 0.94), 9)
    bpy.context.scene.render.filepath = os.path.join(OUTPUT, "market-chart-platform.png")
    bpy.ops.render.render(write_still=True)


def connector_points(start, end, bend):
    return [
        Vector(start),
        Vector(bend),
        Vector(end),
    ]


def add_dotted_path(name, start, end, bend, mat, count=24):
    p0 = Vector(start)
    p1 = Vector(bend)
    p2 = Vector(end)
    for index in range(count):
        t = index / max(1, count - 1)
        point = (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2
        if index % 2 == 0:
            bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=0.035, location=point)
            dot = bpy.context.object
            dot.name = f"{name} {index}"
            dot.data.materials.append(mat)


def render_topology():
    clear_scene()
    configure_render(900, 430)
    dark = material("Topology metal", (0.012, 0.035, 0.05), 0.8, 0.2)
    cyan = material(
        "Topology cyan",
        (0.01, 0.34, 0.54),
        0.25,
        0.15,
        emission=(0.03, 0.62, 1.0),
        emission_strength=2.7,
    )
    green = material(
        "Topology green",
        (0.18, 0.42, 0.05),
        0.2,
        0.15,
        emission=(0.56, 1.0, 0.22),
        emission_strength=4.0,
    )
    packet_green = material(
        "Moving packet green",
        (0.12, 0.82, 0.01),
        0.0,
        1.0,
        emission=(0.18, 1.0, 0.015),
        emission_strength=0.95,
    )
    packet_bsdf = packet_green.node_tree.nodes.get("Principled BSDF")
    if "Specular IOR Level" in packet_bsdf.inputs:
        packet_bsdf.inputs["Specular IOR Level"].default_value = 0.0

    central_glow = add_cylinder(
        "Central hex base",
        6,
        1.18,
        0.23,
        (0.4, 0.0, 0.0),
        dark,
        0.1,
        rotation=(math.radians(90), 0, math.radians(30)),
    )
    online_light = add_cylinder(
        "Central hex glow",
        6,
        1.20,
        0.035,
        (0.4, -0.14, 0.0),
        cyan,
        0.045,
        rotation=(math.radians(90), 0, math.radians(30)),
    )
    add_cylinder(
        "Central hex face",
        6,
        1.08,
        0.045,
        (0.4, -0.18, 0.0),
        dark,
        0.05,
        rotation=(math.radians(90), 0, math.radians(30)),
    )
    add_cylinder(
        "Central online light",
        32,
        0.09,
        0.04,
        (0.4, -0.23, -0.56),
        green,
        0.02,
        rotation=(math.radians(90), 0, 0),
    )

    left_endpoints = [(-3.65, 0.0, 1.55), (-3.65, 0.0, 0.0), (-3.65, 0.0, -1.55)]
    left_bends = [(-1.4, -0.2, 1.45), (-1.45, -0.2, 0.0), (-1.4, -0.2, -1.45)]
    hub_points = [(-0.75, -0.12, 0.62), (-0.88, -0.12, 0.0), (-0.75, -0.12, -0.62)]
    for index, (start, bend, end) in enumerate(zip(left_endpoints, left_bends, hub_points)):
        add_dotted_path(f"Left signal {index}", start, end, bend, cyan, 30)
        add_cylinder(
            f"Left endpoint {index}",
            32,
            0.09,
            0.04,
            start,
            green,
            0.02,
            rotation=(math.radians(90), 0, 0),
        )

    add_dotted_path(
        "Right execution signal",
        (1.56, -0.12, 0.0),
        (3.7, 0.0, 0.0),
        (2.55, -0.22, 0.0),
        cyan,
        28,
    )
    add_cylinder(
        "Right endpoint",
        32,
        0.09,
        0.04,
        (3.7, 0.0, 0.0),
        green,
        0.02,
        rotation=(math.radians(90), 0, 0),
    )

    camera_data = bpy.data.cameras.new("Topology Camera")
    camera = bpy.data.objects.new("Topology Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    camera.location = (0, -12.5, 0.0)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 8.7
    point_camera(camera, (0, 0, 0))

    add_area_light("Topology key", (0, -4, 5), 500, (0.28, 0.78, 1.0), 7)
    bpy.context.scene.render.filepath = os.path.join(OUTPUT, "observatory-topology.png")
    bpy.ops.render.render(write_still=True)

    # The animated WebP is an overlay, not a second copy of the topology.
    # Hide every static mesh/curve so only saturated green packets travel over
    # the white/cyan route supplied by the still image beneath it.
    for scene_object in bpy.context.scene.objects:
        if scene_object.type in {"MESH", "CURVE"}:
            scene_object.hide_render = True

    frame_end = 48
    packet_paths = [
        ((-1.95, 0.0, 1.30), left_bends[0], hub_points[0]),
        ((-1.95, 0.0, 0.0), left_bends[1], hub_points[1]),
        ((-1.95, 0.0, -1.30), left_bends[2], hub_points[2]),
        ((2.08, 0.0, 0.0), (1.84, -0.18, 0.0), (1.56, -0.12, 0.0)),
    ]
    for index, (start, bend, end) in enumerate(packet_paths):
        add_animated_packet(
            f"Live packet {index}A",
            start,
            bend,
            end,
            packet_green,
            0.0,
            frame_end,
            radius=0.085,
        )
    animate_emission(
        packet_green,
        [(1, 0.85), (12, 1.1), (24, 0.9), (36, 1.15), (49, 0.85)],
    )
    render_animation_to_apng("observatory-topology-loop", frame_end)


if __name__ == "__main__":
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not arguments or "platform" in arguments:
        render_platform(include_animation=True)
    elif "platform-static" in arguments:
        render_platform(include_animation=False)
    if not arguments or "chart-platform" in arguments:
        render_chart_platform()
    if not arguments or "topology" in arguments:
        render_topology()
    print(os.path.join(OUTPUT, "market-floor-platform.png"))
    print(os.path.join(OUTPUT, "observatory-topology.png"))
    print(os.path.join(OUTPUT, "market-floor-platform-loop.webp"))
    print(os.path.join(OUTPUT, "market-chart-platform.png"))
    print(os.path.join(OUTPUT, "observatory-topology-loop.webp"))
    print(os.path.join(OUTPUT, "observatory-topology-loop.png"))
