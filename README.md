# Pore Pressure

A macro skin extraction simulator that runs in the browser (WebGL2).

- **Skin:** rebuilt from real macro photographs. They are split into melanin, hemoglobin, relief and fine-detail maps, then relit with a studio HDRI and subsurface scattering.
- **Lesions and tools:** 29 lesion types across six body areas plus close-ups anywhere, and 18 clinical instruments (gloved fingers, comedone loop, pore vacuum, needle, #11 and #15 blades, punch, hemostat, forceps, lidocaine and more).
- **Interactions come from physics, not scripts.** Contact forces load each lesion's cavity. Then either the roof or the follicle/cyst wall fails, and the contents flow out according to their material.
- **Wounds:** cuts gape and punch holes turn oval along the skin's tension lines.
- **Your own blemishes:** use the **Add blemish** menu; **Erase** (or X) removes them.
- **Moving around:** drag clear skin to move it. A drag that starts on a blemish uses your instrument, and blades cut wherever you drag. You can also use the **Move** tool (M), hold **Space**, or right-drag. Zoom with **− / + / Fit**, the scroll wheel or a pinch.
- **Whole face and upper body:** the close-up zooms out to 3× the patch (the skin carries on past its edge). Scroll out further and the same scroll carries on into a 3D bust from the same spot and scale, with every area's blemishes on it. **Face** jumps straight there.
  - Zooming only ever follows your scroll or pinch, toward the cursor; nothing zooms or flies by itself.
  - Drag to move the bust; right-drag, Shift-drag, two fingers or the arrow keys turn it.
  - Zoom into any spot to hand over to a close-up right there: cheek, temple, ear, jaw, neck, chest, shoulder, scalp or upper back. Each gets blemishes typical of that site.
  - Every area and close-up keeps its state, so what you popped stays popped.
- **Fitted to the lesion:** fingers and cotton buds land just outside the edge of the blemish you press on: tight for a blackhead, both thumbs well apart for a cyst. `[` / `]` or Shift+scroll nudge the spacing from there.
- **Lesions respond by type:**
  - Pressed, a pustule's head swells and whitens, a blackhead's plug rises from the pore, and a cyst bulges tight and its punctum gapes.
  - Deep cysts get far less of your pressure than superficial pustules, so they take more force, and big ones take longer to empty.
  - The **Pop** meter shows how close the roof is to popping outward (violet) or the wall to bursting inward (amber).
- **Blades:**
  - A #11 stabs short and deep; a #15 sweeps along your stroke.
  - Cutting a pressurised lesion makes it gush along the cut, and the cut is pushed wider open.
  - Solid papules only bleed, and inflamed tissue bleeds more.
  - A cyst slit shows its white wall over keratin, a lipoma its fat, and a pus pocket its pus.
- **Pus and blood behave like liquids:**
  - Contents well up at the opening as a bead that grows until it is too heavy for the slope. It then runs downhill, leaving a thin wet trail, and stops once small enough. The clinging limit is the Furmidge balance: blood holds to about 3.6 mm wide on vertical skin. Touching beads merge into one pool, drawn as a single liquid surface with menisci.
  - Blood is turbid: thin films are translucent bright red and thicker pools are deep crimson.
  - Pus is opaque cream, serum is clear straw, and mixtures turn pink or streaky.
  - Shed blood gels after a few minutes, films dry, and stains darken on the oxidation clock.
  - Pus, keratin and chalk are sticky and stay where they land.
  - Only real pressure makes a jet (dripping-to-jetting at Weber number ~6).
- **New lesions:**
  - abscess;
  - inflamed (ruptured) epidermoid cyst;
  - friction and blood blisters (a needle at the edge drains them with the roof kept; a #15 makes flaps);
  - gouty tophus on the ear rim and calcinosis cutis (gritty white chalk);
  - Favre-Racouchot comedone clusters on the temples;
  - folliculitis pustules pierced by hairs.
- **Squeezing:** fingertip pads spread as you press harder, grip the skin and drag it inward. The skin between them bunches into a fold that pales on its crest. On release it springs back, about half at once and the rest over a few seconds, then the reactive redness follows.

For entertainment and education only. Squeezing at home risks scarring and infection; see a dermatologist.

## Credits

- Skin macro photographs: Angela Roma (Pexels 7479592, 7479507) and Karola G (Pexels 4046567), [Pexels License](https://www.pexels.com/license/). They were cropped to skin only and processed into maps.
- Studio lighting: Poly Haven "Monochrome Studio 04" HDRI (CC0).
- Face and upper body: [MakeHuman](https://github.com/makehumancommunity/makehuman) base mesh (CC0 1.0). It was cropped to a bust and subdivided, with ambient occlusion baked in `source/tools/build_body.py`.
- Clinical and physical sources are listed in the app under **Settings → Sources**.

`source/` holds the unbundled code and build scripts. `index.html` is the bundled page.
