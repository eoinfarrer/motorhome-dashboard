# Audrey Home scenes

Optional local Home background assets belong here. Audrey is configured to use
the first four paths below when they are present; if a file is absent or fails
to load, its layered gradient scene remains visible instead.

The central `HOME_SCENES` map in `index.html` owns the mapping:

- `home.jpg`
- `mountains.jpg`
- `alpine.jpg`
- `coast.jpg`
- `highlands.jpg`
- `driving.jpg`
- `generic.jpg` (reserved for a future generic photo)

The initial active files are `home.jpg`, `mountains.jpg`, `alpine.jpg`, and
`coast.jpg`. `mountains.jpg` is also used for an explicit driving scene.
Audrey will continue to use its gradient scene treatment if a configured image
is missing, so no missing-image UI is ever exposed.
