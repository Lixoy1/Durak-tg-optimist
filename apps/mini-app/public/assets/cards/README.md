# OPTIMIST card asset placement

Copy each final card as a WebP file into the matching suit folder:

- `clubs/{6,7,8,9,10,J,Q,K,A}.webp`
- `spades/{6,7,8,9,10,J,Q,K,A}.webp`
- `diamonds/{6,7,8,9,10,J,Q,K,A}.webp`
- `hearts/{6,7,8,9,10,J,Q,K,A}.webp`
- `back.webp`

The engine maps ranks 11/12/13/14 to `J/Q/K/A`. The central pip count on numeric cards must be audited before shipping. The backend does not infer rank or suit from image pixels.
