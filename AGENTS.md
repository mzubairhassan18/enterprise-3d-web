# AGENTS.md — Blender MCP Workspace

This project has **no source code**. It is the working directory for driving a live,
already-running Blender instance through `blender-mcp`. The user writes a plain-language
prompt ("build a low-poly robot", "animate a door"), and the agent translates it into
Blender Python, executes it, and verifies the result visually.

**Always read this file first.** It contains hard-won constraints that will otherwise
cost a session to rediscover.

---

## 1. Architecture — how a prompt reaches Blender

```
user prompt
  └─ opencode agent
       └─ MCP tool  tools.blender.*
            └─ mcp_server.py          (spawned by opencode, stdio transport)
                 └─ TCP 127.0.0.1:9876
                      └─ addon/_axsock.py   (socket server INSIDE Blender)
                           └─ exec(code, namespace)  →  bpy
```

There is **no SSE/HTTP bridge** in this chain. Ports 9877 and 9879 are unused and their
"DESCONECTADO" warnings are cosmetic noise — ignore them.

| Piece | Path |
|---|---|
| Blender | `D:\D\blender-installed\blender.exe` — 5.2.1 LTS |
| Bundled Python (holds all MCP deps) | `D:\D\blender-installed\5.2\python\bin\python.exe` |
| Addon root | `C:\Users\hp\AppData\Roaming\Blender Foundation\Blender\5.2\scripts\addons\blender-mcp-docs\` |
| MCP entrypoint | `<addon root>\mcp_server.py` |
| Socket server (command channel) | `<addon root>\addon\_axsock.py` |
| Code guard | `<addon root>\addon\code_guard.py` |
| opencode config | `C:\Users\hp\.config\opencode\opencode.jsonc` → `mcp.servers.blender` |
| MCP server log | `C:\Users\hp\AppData\Roaming\blender-mcp\logs\server.log` |

---

## 2. Startup — two steps, nothing else

1. **Launch Blender.** The addon is enabled in Preferences, so it auto-opens port 9876.
2. **Start opencode** from any directory. The MCP config is global, not project-scoped.

Health check:

```powershell
Get-NetTCPConnection -LocalPort 9876 -State Listen
# expect: 127.0.0.1 : 9876 : OwningProcess = Blender's PID
```

If `9876` is not listening → Blender is closed, or the addon got disabled
(Edit → Preferences → Add-ons → search `blender-mcp` → tick).

### Session-start protocol for the agent

1. Call `get_scene_info` **before** writing any code. Never assume a blank scene.
2. Check what already exists and its bounding positions so new geometry does not
   interpenetrate existing objects.
3. Build, then `get_scene_info` + `get_viewport_screenshot` to verify.
4. Read the screenshot PNG with the **read** tool to actually inspect it.
   `browser.preview` is unavailable — the desktop browser is not connected to this session.

---

## 3. Tools

| Tool | Use |
|---|---|
| `search_api_docs` / `get_python_api_docs` | **Consult before writing code.** Signatures differ from memory. |
| `execute_blender_code` | The primary tool. Runs Python in Blender. |
| `get_scene_info` | Object list, types, locations. Verify after every build. |
| `get_viewport_screenshot` | Saves a PNG and returns its path. |

---

## 4. CODE GUARD — the rules `execute_blender_code` enforces

`addon/code_guard.py` walks the AST and **rejects** code before it runs. Violating these
returns an error instead of building. Variables named `code` are dangerous to use too
(`code` is a blocked import name — avoid it as an identifier).

**Blocked imports:** `os, sys, subprocess, socket, shutil, pathlib, importlib, ctypes,
pickle, marshal, builtins, webbrowser, http, urllib, requests, asyncio, threading,
multiprocessing, signal, resource, mmap, code, codeop, runpy, site`

`bpy`, `bmesh`, `math`, `mathutils` are **allowed**.

**Blocked calls** (both bare and as an attribute, e.g. `x.open()`):
`exec, eval, compile, open, __import__, input, breakpoint, globals, locals, vars,
delattr, setattr, getattr, exit, quit, system, popen`

**Blocked methods — only when the receiver's root is dangerous**
(`os, shutil, pathlib, Path, subprocess, multiprocessing, tempfile, zipfile, tarfile,
ftplib, socket`): `remove, unlink, rmdir, makedirs, rmtree, kill`

So `bpy.data.objects.remove(o, do_unlink=True)` **is allowed** (root is `bpy`), while
`os.remove(...)` is not. Attribute chains rooted at `bpy`, `C`, `D`, `ops` are allowed.

**Blocked attributes:** any dunder (`__class__`, `__globals__`, …).

### Text rewriting applied before parsing (`_strip_bad_code`)

- Lines matching `bpy.context.collection.objects.unlink(...)` and
  `bpy.context.scene.collection.objects.unlink(...)` are **silently deleted**. Never use
  `unlink` — do not move objects between collections; parent them instead.
- Any literal `.scale = (...)` gets every `/ 2` removed from inside the parentheses.
  **Write `o.scale = dim` (a variable), not `o.scale = (a/2, b/2, c/2)`** — a variable
  does not match the regex at all.

### Batch mode and failure behavior

Code containing `"for "` or `"while "` is treated as *batch*: no undo push, and on
exception the partial result is **left in place** (no automatic undo). Code without them
triggers `bpy.ops.ed.undo()` on failure. Expect and plan for this.

The exec namespace is pre-seeded with `bpy, C, D, ops, window, screen`.
There is no timeout on Windows (the `SIGALRM` guard is compiled out).

---

## 5. Patterns that work — reuse these

**Idempotent cleanup.** Prefix every created object and delete by prefix on re-run:

```python
for o in list(bpy.data.objects):
    if o.name.startswith("House_"):
        try:
            bpy.data.objects.remove(o, do_unlink=True)
        except Exception:
            pass
```

**Materials.** Look up by name so re-runs reuse instead of duplicating. Set **both** the
Principled node (for Material Preview / render) and `diffuse_color` (for Solid shading —
otherwise everything looks default grey):

```python
m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
m.use_nodes = True
m.diffuse_color = (r, g, b, 1.0)
bsdf = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
# set "Base Color", "Metallic", "Roughness"
# emission: inputs["Emission Color"] with fallback to ["Emission"], plus ["Emission Strength"]
```

**Parenting — the transform trap.** `o.parent = p` leaves `matrix_parent_inverse`
as identity, so the child's `location` is reinterpreted in parent space. Convert it:

```python
def parent_keep(o, p):          # ONLY valid if p has identity rotation and unit scale
    o.parent = p
    o.location = (o.location.x - p.location.x,
                  o.location.y - p.location.y,
                  o.location.z - p.location.z)
```

**Bake object scale into the mesh before parenting children to it.** A non-uniformly
scaled parent multiplies every child's dimensions. Bake it:

```python
o.scale = dim
sx, sy, sz = o.scale
for v in o.data.vertices:
    v.co = (v.co.x * sx, v.co.y * sy, v.co.z * sz)
o.scale = (1, 1, 1)
```

**Hinged parts (doors, lids, gates).** Never rotate the panel around its own center.
Create an empty on the hinge edge, parent panel + handle to it, keyframe the empty:

```python
hinge.rotation_euler = (0, 0, angle)
hinge.keyframe_insert("rotation_euler", frame=f)
```

**Animation.** Verified signature — `frame` is **keyword-only**:

```python
obj.keyframe_insert("location", frame=f)      # ✅   keyframe_insert(data_path, *, ..., frame=None, ...)
obj.keyframe_insert("location", 10)           # ❌ raises
```

- Default extrapolation is flat, so a single start key + a single end key is enough —
  the object holds the first value until the first key.
- Ease in/out comes free from default Bezier handles.
- For a landing bounce, add overshoot keyframes (`final+ε`, `final-ε`, `final`).
  Do **not** try to edit fcurves for interpolation — Blender 4.4+ slotted actions make
  that API fragile.
- Set `scene.frame_start`, `scene.frame_end`, `scene.render.fps`, then `scene.frame_set(1)`.

**Custom geometry** without operators (context-free, safest):

```python
me = bpy.data.meshes.new("Mesh"); me.from_pydata(verts, [], faces); me.update()
bm = bmesh.new(); bm.from_mesh(me)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(me); bm.free()
o = bpy.data.objects.new("Name", me)
bpy.context.scene.collection.objects.link(o)
```

**Viewport.** Switching shading and framing are safe if done on data (not operators):

```python
space.shading.type = 'MATERIAL'          # iterate window_manager.windows → areas → spaces
with bpy.context.temp_override(window=w, area=a, region=r):   # region type 'WINDOW'
    bpy.ops.view3d.view_all()            # or view_selected()
```

---

## 6. Failure modes to avoid

| Mistake | Consequence |
|---|---|
| `pip install fastmcp` into Blender's Python | Drags in `mcp` 2.x → `mcp.server.fastmcp` is renamed/removed → MCP server dies. **Keep `mcp<2` (currently 1.30.0).** |
| `uvx blender-mcp install-addon` or `blender-mcp-bridge serve` | The PyPI package fights your addon for port 9876. Do not install it. |
| Frame 1 has parts in exploded start positions | `view_all` zooms way out to include a roof parked at z+10. **Frame the view at an assembled frame instead.** |
| Rapid consecutive screenshots | The screenshot tool returned the *same* filename for three frames in a row, overwriting. Verify the path changes between shots. |
| Trusting a viewport screenshot for camera framing | At f1040 the viewport showed a south-west *user* view even though `region_3d.view_perspective` printed `CAMERA`. Verify camera framing with a real low-res render instead: set `resolution 512×288`, `bpy.ops.render.render(write_still=True)` to a temp path, then `read` the PNG. Projection truth comes from `bpy_extras.object_utils.world_to_camera_view(scene, cam, point)` — NDC `x,y ∈ [0,1]` and `z > 0` means in frame. |
| Framing the mosque from south-east of the roundabout | The fountain at `(16, −7.5)` lands dead between camera and mosque — its blue crown overlaps the teal dome and the hall is hidden. Stand on the south kerb `(7, −10.25)` instead: the sight line clears the roundabout by 5.6 units and the fountain sits just outside the right edge. |
| Reinstalling Blender | Addon folder (and all 5 bug fixes) is wiped. Re-tick the addon and re-apply fixes. `.bak` files sit next to the patched originals. |
| Bulk-deleting `bpy.data.actions` with `a.users == 0` | This time it only killed the 6 dead ped actions **and stale camera duplicates** — `Cam_WalkAction` was orphaned while the **live** one was `Cam_WalkAction.001`. Harmless, but always print `obj.animation_data.action.name` before a sweep: Blender happily abandons an original when a `.001` variant takes over, and a live action can look dead. |

The five addon bug fixes are already persisted on disk — do not redo them.

---

## 7. Current scene state

*Update this section whenever the scene changes materially.*

- Blender 5.2.1 LTS, GUI process running. Saved as **`D:\blender-mco\society.blend`**
  (the pre-society baseline is kept as `house_society.blend`). Re-save after big edits.
- **201 objects · 85 animated · 140 carry `bs_hide`:** 14 `House_*` + 14 `House2_*` +
  14 `House3_*`, 39 `Fence_*`, 10 `Tree_*`, 14 `Mosque_*`, 9 `Gate_*`,
  **66 `Ped_*` = 6 articulated rigs × 11 objects**, 4 each of
  `Road_`/`Round_`/`Fount_`/`Water_`, 2 `Spill_*`, 2 `Cam_*`, `Sun`.
  The old default `Light`, the `Cube`, the robot and the old single-mesh
  `Ped_01..06` are gone. Only the six `Ped_*_Root` empties carry `bs_*`.
- **Layout (Blender coords):** road runs x −20…+11 at y −7.5 (asphalt y −9.5…−5.5,
  sidewalks to −4.0 / −11.0); gate at x −17; house1 root (−3.6, 0) + fence/trees;
  house2 root (5, 0); house3 root (0, −14.6) rotated 180° so it faces the road;
  roundabout centred (16, −7.5) r 5.2 with the fountain/waterfall on it;
  mosque hall x 13…19, y −0.5…4.5 with the minaret on the roof at (13.4, 0.3).
- A **`Sun`** light now exists (added for the GLB export). The original default `Light`,
  the `Cube`, and a 35-part robot built earlier are gone — removed outside this agent's
  code. The GLB itself exports **no lights** (`export_lights` off); `main.js` lights the
  scene itself with a DirectionalLight + HemisphereLight, so do not rely on Blender lights
  for the web version.
- **Web export lives in this directory:** `scene.glb` (454 KB), `index.html`, `main.js`,
  `style.css`. Serve it — `file://` will not fetch the GLB:
  `D:\D\blender-installed\5.2\python\bin\python.exe -m http.server 8000` →
  `http://localhost:8000/`. Scroll maps to frames 1→1150 and is **reversible**.
  Re-export after any scene change — **`export_cameras=True` is mandatory**, otherwise
  the `Cam_Walk` node is dropped and the walkthrough camera disappears from the page:
  `bpy.ops.export_scene.gltf(filepath="D:/blender-mco/scene.glb", export_format="GLB", export_animations=True, export_extras=True, export_cameras=True)`
- **The camera is authored in Blender and exported — there are no `CAM_*` orbit
  constants left in `main.js`.** `Cam_Walk` (a 28 mm camera) plus `Cam_WalkTarget`
  (a TRACK_TO empty) hold **17 location waypoints across f1→1150**: start
  (−26, −7.5, 1.6) eye height on the road outside the gate → through the gate →
  glance south at house3 (f150) → north at house1 (f300) → east along the road →
  stop at the roundabout entrance `f960 (9.5, −9.8)` still facing the waterfall →
  step back to the south kerb `(7, −10.25)` and look up at the minaret
  (f1000, aim `(14, 1, 8)`) → settle on the mosque front (f1040, aim
  `(16, 2, 5.75)`, position held — only the aim pans) → crane to the bird's eye
  `(0, −32, 34)` aiming `(−1, −4, 0)` at f1150.
  Both are tagged `bs_kind='pos'` with a flat `bs_pos` key list, and `main.js`
  copies their translation into its own camera every frame. To retime or reroute
  the walk, move those keys in Blender, re-derive `bs_pos` (see the axis rule
  below) and re-export.
- **Full animation range 1–1150 @ 24 fps. Press Space to play.**
  - the original house's animation was shifted **+149 frames**, so its windows are now
    `House_*` 150→378 — walls `150→167`, door slide `187→205`, roof `199→228`
    (drops from +Z), hinge swing `237→297` (open, hold, close), fence pickets
    `309→~378` staggered, `Tree_L` 329→367, `Tree_R` 341→379
  - `House3_*` (across the road, rotated π) = house windows −90 → **60→217**
  - `House2_*` = house windows +240 → **390→567**
  - road/sidewalks/dashes `f20→140` — scale from x −20 so the road draws eastward
    ahead of the walker
  - gate root `f10→55`; gate arms `f45→90` (∓1.4 rad, opening outward)
  - pedestrians have **no fcurves at all** — `Ped_*_Root` carries only `bs_hide=140`
    (so they step onto the finished road/sidewalk) plus `ped_path`/`ped_speed`/
    `ped_dir0`; `main.js updateWalkers()` walks them in **wall-clock time**,
    independent of the scrollbar (see the walker contract below)
  - roundabout `f700→790`, fountain basin `f750→830`, water `f800→870`,
    spill curtain `f840→910`
  - mosque root `f860→990`, minaret `f940→1070`
  - camera walk `f1→1150` (see the camera bullet above)
  - **All parts keyframe scale from `TINY=(0.001,)` → `ONE`, origin at the part's base**
    so growth reads as rising from the ground. Fence rails grow along their length
    because their origin sits at one end.
- Hierarchy: `House_Root` → walls/floor/roof/hinge; `House_DoorHinge` → `House_Door` →
  `House_DoorHandle`; `House_FrontL/R` → `House_WindowL/R`; `Tree_*_Canopy` → `Tree_*_F*`.
- Select `House_Root` to move the house, `Tree_*_Canopy` to inspect foliage growth.
- **Frame the viewport at ~f1150** (bird's eye, everything final) or at a section's
  *last* frame — never at f1, or `view_all` zooms out to include exploded start poses.
- Blender does **not** honour `bs_hide` (it is a `main.js` concept only), so scrubbing
  the timeline in Blender always shows every part, including the scattered start poses.

### The `bs_*` build metadata (required by `main.js`)

Scroll-driven building does **not** use the exported animation clips (85 of them exist
but per-object clips can desync). Instead every animated object carries custom props,
which glTF writes into `node.extras`:

| prop | meaning |
|---|---|
| `bs_kind` | `"loc"` \| `"scale"` \| `"rot"` \| `"pos"` (camera / aim waypoints) |
| `bs_win` | `(f_start, f_end)` — its window on the **1–1150** timeline |
| `bs_off` | start offset for `loc` parts, **stored in glTF Y-up**: Blender `(x,y,z)` → `(x, z, -y)`; `end = static − bs_off` |
| `bs_rot` | flat `(f, val, f, val, …)` key list, angle about Blender **Z** = glTF **Y** |
| `bs_pos` | flat `(f, x, y, z, …)` waypoints for `bs_kind='pos'`, **glTF Y-up** |
| `bs_hide` | earliest frame the node *and its subtree* may be shown; `main.js` toggles `node.visible`. Parents are clamped to `min(own, children)` so a parent (e.g. `House_DoorHinge`) can never hide a child that starts earlier (e.g. `House_Door`). **Blender ignores `bs_hide`.** |

Objects carrying **only** `bs_hide` and no `bs_kind` (house floors, windows, door
handles, the three `*_Root` empties) are still read by `main.js` — they are the
static parts that must not float in mid-air before their house starts building.

**Pedestrians are the one exception to scroll-driven motion.** Each `Ped_0X_Root`
empty carries `bs_hide` plus three walker props — and deliberately **no**
`bs_kind` / `bs_win` / `bs_off`:

| prop | meaning |
|---|---|
| `ped_path` | `(x0, x1)` — the stretch of pavement it paces (Blender X = glTF X, so no axis conversion) |
| `ped_speed` | walking speed in m/s |
| `ped_dir0` | `+1` east / `−1` west — initial heading |

Only the root is tagged; its 10 children (`Body`, `Head`, `Hair`, `Eyes`,
`ArmL/R`, `LegL/R`, `ShoeL/R`) carry **no** extras, so `applyFrame()` never
touches them. Hierarchy: `Root → {Body → Head → {Hair, Eyes}, LegL → ShoeL,
LegR → ShoeR, ArmL, ArmR}`; limb origins sit at the joint (hip / shoulder /
neck) so rotating the limb swings it.

`main.js updateWalkers()` drives them from `performance.now()`, never from the
frame: translation along `ped_path`, a pivot (`rotation.y` 0 ↔ π) at each path
end with translation frozen while the stride keeps cycling, legs/arms swinging
about the limb's local **Z** (the rig is authored facing **+X** in Blender, so
a positive Z rotation sends the foot forward in glTF too), a double-frequency
bob on `position.y`, a sway/lean on `Body`. Six walkers, six disjoint `ped_path`
ranges (gap ≥ 1 unit) so no two ever collide. **The three peds per sidewalk
never cross — a path edit must keep the ranges disjoint.**
In Blender the rig sits at rest and is always visible (Blender ignores
`bs_hide`), so a Blender screenshot shows them standing still — that is
expected, not a bug.

**Axis conversion happens in Blender, exactly once.** The exporter writes `extras`
verbatim — it does *not* convert them — while node `translation`/`scale` *are*
converted to Y-up. So `bs_off` and `bs_pos` are stored **already converted**
(Blender `(x,y,z)` → `(x, z, −y)`), guarded by the scene marker
`sc["bs_axis_gltf"] = 1`. If you re-derive either prop from f-curves you must
apply the same conversion yourself before exporting, and never run the converter
twice (it would flip the sign again).

If you add new animated objects, you **must** write these props before re-exporting,
or the parts will not animate.

**Critical — the exporter bakes the animation's FIRST key, not the final pose.**
Every animated node's static `translation`/`scale`/`rotation` in the GLB equals the
*start* of its action, regardless of what frame Blender was on when exporting
(verified by parsing `scene.glb`: `House_WallLeft` static = `-7.44` but its last key
= `-1.44`; `House_Roof` static `y=10`, last key `y=0`; `Fence_F_P00` static scale
`= 0.001`, last key `= 1.0`). So `main.js` computes:

- `loc` → `start = node.position`, `end = start - bs_off`
- `scale` → `start = node.scale` (0.001), `end = (1,1,1)`
- `rot` → static is identity, `bs_rot` is an absolute angle applied about Y
- `pos` → static is the first waypoint; `main.js` ignores it and follows `bs_pos`

Non-animated objects export their normal (final) transform, which is why only the
tagged `bs_*` objects need this treatment. glTF time is absolute `frame / 24` with
no offset, and rotation channels are sampled per-frame with easing baked in.

---

## 8. What the user wants to do

They give natural-language prompts and expect the object to appear in Blender. Typical
requests so far: a low-poly robot, a house assembled from parts, hinged/animated motion.

Capabilities already proven end-to-end: primitive + custom-mesh modeling, materials with
emission, hierarchy and pivots, keyframed animation, visual verification by screenshot.

Good things to offer unprompted: a `Ctrl+S` reminder before big edits, placement checks
against existing geometry, and a screenshot after building so they can confirm.
