"""Builds the distributables in dist/ (Python standard library only).

python3 tools/package.py   →  dist/feedback-lens-<version>.zip                    README, UNTERNEHMEN.md, docs and extension/ (to load unpacked)
                              dist/feedback-lens-<version>-chrome-web-store.zip  only the extension, manifest.json at the root
                                                                                  (Chrome Web Store, Edge Add-ons)
                              dist/feedback-lens-<version>-store-paket.zip       everything for the store submission (store/,
                                                                                  UNTERNEHMEN.md and the store ZIP)
                              dist/feedback-lens-<version>-projekt.zip           the whole project (sources, tests, tools)
"""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
version = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))["version"]
DIST = ROOT / "dist"
DIST.mkdir(exist_ok=True)


def extension_files():
    for path in sorted(EXT.rglob("*")):
        if path.is_file() and not any(part.startswith(".") for part in path.relative_to(EXT).parts):
            yield path, path.relative_to(EXT).as_posix()


bundle = DIST / f"feedback-lens-{version}.zip"
with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as zf:
    zf.write(ROOT / "README.md", "feedback-lens/README.md")
    zf.write(ROOT / "UNTERNEHMEN.md", "feedback-lens/UNTERNEHMEN.md")
    for path in sorted((ROOT / "docs").glob("*.png")):
        zf.write(path, f"feedback-lens/docs/{path.name}")
    for path, rel in extension_files():
        zf.write(path, f"feedback-lens/extension/{rel}")

store = DIST / f"feedback-lens-{version}-chrome-web-store.zip"
with zipfile.ZipFile(store, "w", zipfile.ZIP_DEFLATED) as zf:
    for path, rel in extension_files():
        zf.write(path, rel)



def tree(folder):
    for path in sorted((ROOT / folder).rglob("*")):
        rel = path.relative_to(ROOT)
        if path.is_file() and not any(part.startswith(".") or part == "__pycache__" for part in rel.parts):
            yield path, rel.as_posix()


kit = DIST / f"feedback-lens-{version}-store-paket.zip"
with zipfile.ZipFile(kit, "w", zipfile.ZIP_DEFLATED) as zf:
    for path, rel in tree("store"):
        zf.write(path, "feedback-lens-store/" + rel.removeprefix("store/"))
    zf.write(ROOT / "UNTERNEHMEN.md", "feedback-lens-store/UNTERNEHMEN.md")
    zf.write(store, f"feedback-lens-store/{store.name}")

project = DIST / f"feedback-lens-{version}-projekt.zip"
with zipfile.ZipFile(project, "w", zipfile.ZIP_DEFLATED) as zf:
    for name in ("README.md", "UNTERNEHMEN.md"):
        zf.write(ROOT / name, f"feedback-lens/{name}")
    for folder in ("docs", "extension", "store", "test", "tools"):
        for path, rel in tree(folder):
            zf.write(path, f"feedback-lens/{rel}")

for out in (bundle, store, kit, project):
    print(f"{out} ({out.stat().st_size // 1024} KB)")
