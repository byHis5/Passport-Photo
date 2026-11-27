# Passport Photo Generator (web version)

A web page that turns a customer photo into a print-ready passport photo. **Everything runs inside the browser** (Chrome or Edge recommended) on the computer that opens it:

* Nothing to install.
* Customer photos never leave the computer.
* It works offline after the first visit.
* It's free to host.

## What it does

1. **Upload** a photo (drag & drop, click, or Ctrl+V paste). Sideways or upside-down photos are turned upright automatically. Use ⟲ / ⟳ if one isn't.
2. **Choose the document.** United States Passport is the default and first in the list, followed by more than 200 country and document sizes. Type to search.
3. **Retouch** (automatic, adjustable):
   * White background. The built-in remover runs a second close-up pass on the head and hair and snaps the outline to the real edges. It replaces any colour from the old background in the hair and along the edges with white, and clears wall shadows cast next to the person. Along the last few pixels of the outline, anything that is the wall's colour but darker than the lit wall is treated as shadow and turned white. Skin has a different colour, and dark hair and beards are far darker than a shadow. Larger shadow patches are cleared when they're wall-coloured, smooth and fade softly into the wall. Hair, ears, shoulders and clothing (which have texture or a sharp edge) are kept, and the face is never touched. If anything is left, **Brush › Erase background** paints it white, and **Brush › Restore person** brings back anything removed by mistake.
   * Slight airbrush, on skin only. Eyes, lips, brows, beards and hair are left alone, and texture is kept.
   * Slight blemish fix
   * Dark-skin exposure. *Auto* gently lifts a dark face so the features read clearly, without changing the skin tone. It can also be set to *Always on* or *Off*.
4. **Position.** The head is auto-straightened, then sized and placed to the country's head-height and eye-height rules. Guide lines and ✓/✗ measurements show the result.
5. **Special instructions:** one-tap buttons, free and offline.
   * **Jewelry:** Remove all jewelry, Necklace, Earrings, Nose ring. Metal-coloured jewelry (gold, silver, white) on bare skin is found and erased automatically; clothing is never touched. Jewelry on top of clothing, and dark jewelry, isn't found: paint over it with **Brush › Heal spots / jewelry**.
   * **Light & colour:** Brighter, Darker, Warmer, Cooler, More contrast
   * **Skin:** Smoother skin, Remove spots
   * **Position:** Straighten, Rotate ⟲ / ⟳ (1° per tap), Bigger, Smaller, ↑ ↓ ← →
   * **✓ Check photo** shows the automatic measurements, or an AI review when a Claude key is set. **↺ Reset** puts position and tone back.
   * **Type your own instruction** (folded away under the buttons) understands the same commands. With a Claude API key (⚙ Settings) you can ask for anything.
   * The **Brush** menu above the photo has **Heal spots / jewelry**, **Erase background** and **Restore person**. **Undo brush** steps back one stroke at a time.
6. **Output**: 300 dpi JPG
   * **Single photo**, for emailing.
   * **4×6 sheet, max copies**: 6 for US 2×2, 8 for 35×45 mm, 9 for China.
   * **4×6 sheet, 4 copies + coupon**: a random coupon goes underneath. *Different coupon* picks another.
   * **4×6 sheet, 3 × 2×2 in + 4 × 35×45 mm**: the same photo in both sizes on one sheet. It uses the selected document if it's one of those sizes, otherwise US passport and the 35×45 mm standard (head 32–36 mm).

## Hosting (free)

The folder is a plain static website. It must be served over **https** (or `http://localhost`). Opening `index.html` by double-clicking won't work, because browsers block the AI models from loading off the local disk.

**GitHub Pages** (recommended):

1. Create a **public** repository and upload the contents of this folder.
2. Go to *Settings → Pages → Deploy from branch → main / (root)*.
3. The site appears at `https://<username>.github.io/<repo>/` after a minute.

Every file is under 25 MB, so the folder can also be uploaded through the GitHub website.

**Any static host** works too, such as Netlify or your own web hosting. Upload the folder as-is.

**Try it locally:** run this in the folder, then open http://localhost:8080:

```bash
python -m http.server 8080
```

### First visit

The first visit downloads about 85 MB (AI models + image libraries). After that everything is cached, the page opens in seconds, and it works without internet. The page reloads itself once on the first visit to enable multi-threaded processing.

Tip: in Chrome or Edge, use the *install app* icon in the address bar to get a desktop shortcut that opens in its own window.

## Settings

* **Claude API key** (⚙ Settings): needed only for *Special instructions*. Get a key at console.anthropic.com. It's stored in that browser on that computer and sent only to Anthropic. Each instruction costs roughly 1–2¢.
* **Coupons** (right panel): *+ Add coupon images*. Added coupons are saved in that browser on that computer. To make a coupon built-in for every computer, put the image in `coupons/` and add its file name to `coupons/manifest.json`.
* **Country sizes**: edit `data/countries.json`.
  * Entries marked *official spec* are widely published requirements.
  * Entries marked *verify with consulate* use the most common known value, or the ICAO 35×45 mm default. Confirm these.
  * *Custom size…* at the end of the list takes any size.

## Printing
Sheets are laid out to save cutting time. The photos touch each other and start in the top-left corner of the paper. Every cut runs straight across the whole sheet, the paper edges are already cut, and all the waste comes off as one strip on the right or bottom. When two layouts fit the same number of photos, the one needing fewer cuts is used. For example, 35×45 mm prints as a 2×4 grid of sideways photos.

**Cut marks** (on by default; Output › "Cut marks on the offcut paper"): drawn only on the blank offcut paper, never on a photo. Each cut line gets a short light-grey tick where it reaches a blank paper edge, and faint dashes where it crosses blank paper. Line them up with the cutting board's guide. A sheet that photos fill edge to edge (US 2×2, 6 copies) has no offcut, so no marks. "Thin outline on each photo" is a separate option, off by default, that draws a line on each photo's edge.


Print 4×6 sheets **borderless at 100% / actual size**, and turn off "fit to page" and auto-enhance. Two 2-inch photos fill the 4-inch width exactly.

## Limits

* The app can't remove glasses, hats or shadows, and can't change expression or clothing. Those need a retake, and the app warns you.
* Jewelry removal (and Brush › Heal) fills the area from the surrounding pixels. It works well on earrings and studs and on small piercings. Large necklaces are better retaken.
* Best input: an evenly lit photo with the camera at eye level and the face filling about half the frame.

## Files

```
index.html, style.css     the page
js/processing.js          face landmarks, background removal, retouch, straighten + crop
js/layout.js              4x6 sheet packing, coupons
js/ai.js                  Claude vision -> edit plan
js/commands.js            quick commands + automatic jewelry finder (no API key)
js/app.js                 UI
sw.js                     offline cache + multi-threading headers
data/countries.json       passport sizes
coupons/                  built-in coupons (+ manifest.json)
models/                   face landmark model, background-removal model (u2net human seg, 8-bit, split in 3 parts)
vendor/                   OpenCV.js, MediaPipe, ONNX Runtime Web, Anthropic SDK
```

Debug timing: run `localStorage.setItem("ppg.debug","1")` in the browser console and reload.
