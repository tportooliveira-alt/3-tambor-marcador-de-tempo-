#!/usr/bin/env python3
"""
Validação estática do projeto iOS (sem Xcode):
  * Info.plist bem formado e com as chaves obrigatórias;
  * project.pbxproj parseável (pacote pypi `pbxproj`, se instalado) e consistente:
    todo arquivo referenciado existe e todo .swift de ios/App está no alvo;
  * Package.swift e arquivos do pacote presentes;
  * vetores de teste compartilhados presentes e coerentes com o índice.
Uso: python3 Tools/validate_project.py
"""
from __future__ import annotations

import json
import os
import plistlib
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
IOS = os.path.join(ROOT, "ios")
errors: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        errors.append(msg)


def validate_plist() -> None:
    path = os.path.join(IOS, "App", "Info.plist")
    with open(path, "rb") as fh:
        pl = plistlib.load(fh)
    for key in ("NSCameraUsageDescription", "UISupportedInterfaceOrientations", "UILaunchScreen",
                "CADisableMinimumFrameDurationOnPhone", "UIRequiresFullScreen"):
        check(key in pl, f"Info.plist sem a chave {key}")
    orient = pl.get("UISupportedInterfaceOrientations", [])
    check(all("Landscape" in o for o in orient) and orient, "Info.plist: orientações devem ser só paisagem")
    print(f"  Info.plist OK ({len(pl)} chaves)")


def validate_pbxproj() -> None:
    path = os.path.join(IOS, "FotocelulaTambor.xcodeproj", "project.pbxproj")
    text = open(path, encoding="utf-8").read()
    check(text.startswith("// !$*UTF8*$!"), "pbxproj sem cabeçalho UTF8")
    ids = re.findall(r"^\t\t([0-9A-F]{24}) ", text, flags=re.M)
    check(len(ids) == len(set(ids)), "pbxproj com IDs duplicados")
    referenced = set(re.findall(r"\b([0-9A-F]{24})\b", text))
    defined = set(ids)
    dangling = [r for r in referenced if r not in defined]
    check(not dangling, f"pbxproj com referências pendentes: {dangling[:5]}")
    # arquivos referenciados existem / fontes todas no alvo
    swift_files = set()
    for dirpath, _, files in os.walk(os.path.join(IOS, "App")):
        for f in files:
            if f.endswith(".swift"):
                swift_files.add(f)
    in_sources = set(re.findall(r"/\* (\S+\.swift) in Sources \*/", text))
    missing = swift_files - in_sources
    extra = in_sources - swift_files
    check(not missing, f"fontes fora do alvo: {sorted(missing)}")
    check(not extra, f"fontes no alvo que não existem: {sorted(extra)}")
    try:
        from pbxproj import XcodeProject  # type: ignore
        proj = XcodeProject.load(path)
        targets = [t.name for t in proj.objects.get_targets()]
        check("FotocelulaTambor" in targets, f"alvo não encontrado pelo parser pbxproj: {targets}")
        print(f"  project.pbxproj OK (parser pbxproj; alvos: {targets}; {len(in_sources)} fontes)")
    except ImportError:
        print(f"  project.pbxproj OK (checagem própria; instale `pip install pbxproj` para o parser; {len(in_sources)} fontes)")


def validate_package() -> None:
    pkg = os.path.join(IOS, "Packages", "PhotocellCore")
    check(os.path.exists(os.path.join(pkg, "Package.swift")), "Package.swift ausente")
    srcs = os.listdir(os.path.join(pkg, "Sources", "PhotocellCore"))
    tests = os.listdir(os.path.join(pkg, "Tests", "PhotocellCoreTests"))
    check(len(srcs) >= 8 and len(tests) >= 2, "pacote PhotocellCore incompleto")
    print(f"  PhotocellCore OK ({len(srcs)} fontes, {len(tests)} arquivos de teste)")


def validate_vectors() -> None:
    d = os.path.join(ROOT, "shared", "test-vectors")
    idx = json.load(open(os.path.join(d, "index.json")))
    for v in idx["vectors"]:
        check(os.path.exists(os.path.join(d, v["file"])), f"vetor ausente: {v['file']}")
    print(f"  vetores OK ({len(idx['vectors'])})")


def validate_swift_sources() -> None:
    """Checagens rápidas de padrões perigosos nos fontes Swift (sem compilador)."""
    for dirpath, _, files in os.walk(IOS):
        for f in files:
            if not f.endswith(".swift"):
                continue
            p = os.path.join(dirpath, f)
            raw = open(p, encoding="utf-8").read()
            # ignora linhas de comentário para contar delimitadores
            s = "\n".join(l for l in raw.split("\n") if not l.strip().startswith("//"))
            if "CVPixelBufferLockBaseAddress" in raw:
                check("CVPixelBufferUnlockBaseAddress" in s, f"{f}: lock sem unlock")
            check(s.count("{") == s.count("}"), f"{f}: chaves desbalanceadas")
            check(s.count("(") == s.count(")"), f"{f}: parênteses desbalanceados")
    print("  fontes Swift: lock/unlock e balanceamento OK")


def main() -> int:
    print("Validando projeto iOS...")
    validate_plist()
    validate_pbxproj()
    validate_package()
    validate_vectors()
    validate_swift_sources()
    if errors:
        print("ERROS:")
        for e in errors:
            print("  -", e)
        return 1
    print("Tudo OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
