// Colour literals: fails on any colour written as a literal in the
// view's sources outside tokens.css, so every colour on screen
// traces to one token and a theme change stays a one-file change.
// Comment text is not scanned: a colour named in prose is not a
// colour the screen uses. A line scan with a regex is enough — the
// literals have fixed shapes and the sources hold no colour in a
// string that spans lines.

import console from "node:console";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "packages", "view", "src");
const NAMED =
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen";
const LITERAL = new RegExp(
  `#[0-9a-fA-F]{3,8}\\b|rgba?\\([^)]*\\)|hsla?\\([^)]*\\)|(?<![\\w-])(?:${NAMED.split(" ").join("|")})(?![\\w-])`,
  "i",
);

function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (span) =>
    span.replace(/[^\n]/g, " "),
  );
}

let failures = 0;
for (const entry of readdirSync(srcDir, { recursive: true })) {
  const name = String(entry);
  if (!/\.(css|ts|tsx)$/.test(name) || name.endsWith("tokens.css")) continue;
  const path = join(srcDir, name);
  const lines = codeOnly(readFileSync(path, "utf8")).split("\n");
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("//")) return;
    const hit = LITERAL.exec(line);
    if (hit) {
      console.log(
        `${relative(root, path)}:${index + 1}: colour literal "${hit[0]}"`,
      );
      failures += 1;
    }
  });
}
if (failures > 0) process.exit(1);
console.log("colour literals: 0");
