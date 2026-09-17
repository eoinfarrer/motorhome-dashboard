# Audrey background scenes

The four generic photos and four destination photos in this directory are used by Home, Journey, Do, and Van. CSS gradients remain visible if an image cannot load.

`HOME_SCENES` in `index.html` defines the generic fallback. `DESTINATION_SCENES` defines each curated destination's place matcher, season, transport context, image, and phone/tablet/wide focal position. Add new locations there.

Before departure, the picker previews the first curated destination in itinerary order, skipping departure and transit stops. During a trip it uses the active stop and date, with current location taking priority; an arrival flight can supply the region for subsequent hotel rows until the return leg. It reads an explicit transport mode when supplied and otherwise infers flight from the latest itinerary leg. Unknown places, nonmatching seasons, and nonmatching transport contexts use the generic scene.

- Dolomites/Maratona summer cycling: no motorhome.
- Tuscany summer motorhome.
- Lake Annecy summer motorhome.
- Greece summer/autumn beach: no motorhome.
