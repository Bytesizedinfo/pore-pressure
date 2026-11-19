# Pore Pressure

A macro skin extraction simulator that runs in the browser (WebGL2).

- **Skin:** rebuilt from real macro photographs. They are split into melanin, hemoglobin, relief and fine-detail maps, then relit with a studio HDRI and subsurface scattering.
- **Lesions and tools:** 21 lesion types across six body areas, and 18 clinical instruments (gloved fingers, comedone loop, pore vacuum, needle, #11 and #15 blades, punch, hemostat, forceps, lidocaine and more).
- **Interactions come from physics, not scripts.** Contact forces load each lesion's cavity. Then either the roof or the follicle/cyst wall fails, and the contents flow out according to their material.
- **Wounds:** cuts gape and punch holes turn oval along the skin's tension lines.
- **Your own blemishes:** use the **Add blemish** menu; **Erase** (or X) removes them.
- **Moving around:** zoom with **− / + / Fit**, the scroll wheel or a pinch. Drag the skin with the **Move** tool (M), by holding **Space**, or with the right mouse button.
- **Whole face and upper body:** keep scrolling out past the whole patch (or press **Face**) to pull back to a 3D bust with every area's blemishes on it. Drag to turn it, then click an area or zoom into it to go back in. Each area keeps its state, so what you popped stays popped.

For entertainment and education only. Squeezing at home risks scarring and infection; see a dermatologist.

## Credits

- Skin macro photographs: Angela Roma (Pexels 7479592, 7479507) and Karola G (Pexels 4046567), [Pexels License](https://www.pexels.com/license/). They were cropped to skin only and processed into maps.
- Studio lighting: Poly Haven "Monochrome Studio 04" HDRI (CC0).
- Face and upper body: [MakeHuman](https://github.com/makehumancommunity/makehuman) base mesh (CC0 1.0). It was cropped to a bust and subdivided, with ambient occlusion baked in `source/tools/build_body.py`.
- Clinical and physical sources are listed in the app under **Settings → Sources**.

`source/` holds the unbundled code and build scripts. `index.html` is the bundled page.
