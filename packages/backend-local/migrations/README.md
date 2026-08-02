# migrations

Raw SQL migrations, applied by `runMigrations` in this package. No ORM: versioned SQL is inspectable, and the same statements are the basis of the D1 projection in a later phase.

`state/` creates the mutable project database under `.lore/`. `build/` creates the catalog inside a sealed build. They are separate sets on purpose: running both into one database would put empty `builds` and `active_build` tables inside every build, which is the confusion between operational state and canonical content that invariant 1 exists to prevent.

They live inside this package, and `files` in its package.json publishes them, because an asset the code reads has to travel with the code. They used to sit at the repository root, where every test found them and no install did (#164).
