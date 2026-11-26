# VEYRA Blender bridge. Run as:
#   blender -b scene.blend --python export_scene.py -- <out.glb> <report.json>
# Exports the scene to glTF binary (geometry, materials, textures, hierarchy, transforms,
# animation, cameras, lights) and writes a report of anything glTF cannot represent.
import bpy, sys, json

argv = sys.argv[sys.argv.index("--") + 1:]
out_glb, report_path = argv[0], argv[1]

report = {"objects": {}, "untranslated": [], "frame_start": bpy.context.scene.frame_start,
          "frame_end": bpy.context.scene.frame_end, "fps": bpy.context.scene.render.fps}
for ob in bpy.context.scene.objects:
    report["objects"][ob.type] = report["objects"].get(ob.type, 0) + 1
    if ob.type in ("CURVE", "FONT", "SURFACE", "META"):
        report["untranslated"].append(f"{ob.name}: {ob.type} converted to mesh at export time")
    if ob.type in ("VOLUME", "POINTCLOUD", "GPENCIL", "GREASEPENCIL"):
        report["untranslated"].append(f"{ob.name}: {ob.type} objects are not supported by glTF and were skipped")
    for m in getattr(ob, "modifiers", []):
        if m.type in ("PARTICLE_SYSTEM", "FLUID", "CLOTH", "OCEAN"):
            report["untranslated"].append(f"{ob.name}: {m.type} simulation is not exported (bake to mesh/alembic first)")
        if m.type == "NODES":
            report["untranslated"].append(f"{ob.name}: geometry nodes are applied as evaluated mesh")
for mat in bpy.data.materials:
    if mat.use_nodes:
        kinds = {n.type for n in mat.node_tree.nodes}
        unsupported = kinds - {"BSDF_PRINCIPLED", "TEX_IMAGE", "OUTPUT_MATERIAL", "NORMAL_MAP", "MAPPING", "TEX_COORD", "SEPARATE_COLOR", "SEPARATE_RGB", "MIX_SHADER", "EMISSION", "BSDF_TRANSPARENT"}
        if unsupported:
            report["untranslated"].append(f"material {mat.name}: node types {sorted(unsupported)} are approximated (glTF supports Principled BSDF)")

kwargs = dict(filepath=out_glb, export_format="GLB", export_cameras=True, export_lights=True,
              export_animations=True, export_apply=True, export_yup=True)
try:
    bpy.ops.export_scene.gltf(**kwargs)
except TypeError:
    # Older Blender versions use slightly different option names.
    bpy.ops.export_scene.gltf(filepath=out_glb, export_format="GLB")

with open(report_path, "w", encoding="utf-8") as f:
    json.dump(report, f, indent=2)
