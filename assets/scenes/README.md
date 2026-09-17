# Audrey background scenes

The four generic photos and four destination photos in this directory are used by Home, Journey, Do, and Van. CSS gradients remain visible if an image cannot load.

`HOME_SCENES` in `index.html` defines the generic fallback. `DESTINATION_SCENES` defines each curated destination's place matcher, season, transport context, image, and phone/tablet/wide focal position. Add new locations there.

The destination picker uses the active itinerary stop and date, or the next planned stop. Current location takes priority during an active trip. It reads an explicit transport mode when supplied and otherwise infers flight from the latest itinerary leg. Unknown places, nonmatching seasons, and nonmatching transport contexts use the generic scene.

- Dolomites/Maratona summer cycling: no motorhome.
- Tuscany summer motorhome.
- Lake Annecy summer motorhome.
- Greece summer beach: no motorhome.
