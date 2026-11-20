"""Embed the SVG rendered from the checked-in process.mmd."""

import re
import sys
from pathlib import Path

page = Path(__file__).with_name("index.html")
svg = Path(sys.argv[1]).read_text(encoding="utf-8").strip()
svg = re.sub(r"<style>.*?</style>", "", svg, flags=re.DOTALL)
svg = re.sub(r'\sstyle="[^"]*"', "", svg)
svg = svg.replace('xlink:href="#flow-', 'href="#flow-')
expected = set(re.findall(r'click \w+ href "(#flow-[a-z]+)"', page.with_name("process.mmd").read_text(encoding="utf-8")))
links = re.findall(r'<a href="(#flow-[a-z]+)"', svg)
if not expected or set(links) != expected or len(links) != len(expected):
    raise ValueError("Rendered SVG links do not match process.mmd")

begin = "<!-- BEGIN GENERATED MERMAID -->"
end = "<!-- END GENERATED MERMAID -->"
html, count = re.subn(
    rf"{begin}.*?{end}", lambda _: f"{begin}\n          {svg}\n          {end}",
    page.read_text(encoding="utf-8"), flags=re.DOTALL,
)
if count != 1:
    raise ValueError("Expected one generated Mermaid block")
page.write_text(html, encoding="utf-8")
