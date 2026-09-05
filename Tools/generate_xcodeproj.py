#!/usr/bin/env python3
"""
Gera ios/FotocelulaTambor.xcodeproj/project.pbxproj sem depender do XcodeGen.

Formato "clássico" (objectVersion 60, Xcode 15+): referências explícitas a cada arquivo de
ios/App, grupos espelhando as pastas e o pacote local Packages/PhotocellCore ligado ao alvo
(XCLocalSwiftPackageReference + XCSwiftPackageProductDependency).

Uso: python3 Tools/generate_xcodeproj.py   (idempotente: IDs derivados de hashes estáveis)
"""
from __future__ import annotations

import hashlib
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "ios"))
APP_DIR = os.path.join(ROOT, "App")
PROJECT_NAME = "FotocelulaTambor"
BUNDLE_ID = "br.com.tportooliveira.fotocelulatambor"
PACKAGE_PATH = "Packages/PhotocellCore"
PACKAGE_PRODUCT = "PhotocellCore"


def oid(key: str) -> str:
    """ID de 24 hex estável por chave (evita diffs aleatórios a cada geração)."""
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:24].upper()


def q(s: str) -> str:
    """Cita strings do pbxproj quando necessário."""
    safe = all(c.isalnum() or c in "._/" for c in s) and s != ""
    return s if safe else '"' + s.replace('"', '\\"') + '"'


class Group:
    def __init__(self, name: str, path: str):
        self.name = name
        self.path = path
        self.children: list = []   # Group | ("file", relpath, name)
        self.id = oid("group:" + path)


def scan(dir_path: str, rel: str) -> Group:
    g = Group(os.path.basename(dir_path), rel)
    entries = sorted(os.listdir(dir_path))
    for e in entries:
        full = os.path.join(dir_path, e)
        if e.startswith("."):
            continue
        if e.endswith(".xcassets"):
            g.children.append(("file", os.path.join(rel, e), e))
        elif os.path.isdir(full):
            g.children.append(scan(full, os.path.join(rel, e)))
        elif e.endswith(".swift") or e == "Info.plist":
            g.children.append(("file", os.path.join(rel, e), e))
    return g


def file_type(name: str) -> str:
    if name.endswith(".swift"):
        return "sourcecode.swift"
    if name.endswith(".plist"):
        return "text.plist.xml"
    if name.endswith(".xcassets"):
        return "folder.assetcatalog"
    return "text"


def main() -> None:
    app_group = scan(APP_DIR, "App")
    files: list = []      # (relpath, name)

    def collect(g: Group):
        for c in g.children:
            if isinstance(c, Group):
                collect(c)
            else:
                files.append((c[1], c[2]))
    collect(app_group)

    sources = [(p, n) for p, n in files if n.endswith(".swift")]
    resources = [(p, n) for p, n in files if n.endswith(".xcassets")]

    target_id = oid("target")
    project_id = oid("project")
    product_id = oid("product")
    products_group = oid("group:Products")
    packages_group = oid("group:Packages")
    package_fileref = oid("fileref:" + PACKAGE_PATH)
    main_group = oid("group:main")
    frameworks_phase = oid("phase:frameworks")
    sources_phase = oid("phase:sources")
    resources_phase = oid("phase:resources")
    local_pkg_ref = oid("localpkg:" + PACKAGE_PATH)
    product_dep = oid("productdep:" + PACKAGE_PRODUCT)
    pkg_buildfile = oid("buildfile:" + PACKAGE_PRODUCT)
    proj_cfg_list = oid("cfglist:project")
    target_cfg_list = oid("cfglist:target")
    pcfg = {n: oid("cfg:project:" + n) for n in ("Debug", "Release")}
    tcfg = {n: oid("cfg:target:" + n) for n in ("Debug", "Release")}

    out: list[str] = []
    w = out.append
    w("// !$*UTF8*$!")
    w("{")
    w("\tarchiveVersion = 1;")
    w("\tclasses = {")
    w("\t};")
    w("\tobjectVersion = 60;")
    w("\tobjects = {")

    # PBXBuildFile
    w("")
    w("/* Begin PBXBuildFile section */")
    for p, n in sources:
        w(f"\t\t{oid('buildfile:' + p)} /* {n} in Sources */ = {{isa = PBXBuildFile; fileRef = {oid('fileref:' + p)} /* {n} */; }};")
    for p, n in resources:
        w(f"\t\t{oid('buildfile:' + p)} /* {n} in Resources */ = {{isa = PBXBuildFile; fileRef = {oid('fileref:' + p)} /* {n} */; }};")
    w(f"\t\t{pkg_buildfile} /* {PACKAGE_PRODUCT} in Frameworks */ = {{isa = PBXBuildFile; productRef = {product_dep} /* {PACKAGE_PRODUCT} */; }};")
    w("/* End PBXBuildFile section */")

    # PBXFileReference
    w("")
    w("/* Begin PBXFileReference section */")
    w(f"\t\t{product_id} /* {PROJECT_NAME}.app */ = {{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = {PROJECT_NAME}.app; sourceTree = BUILT_PRODUCTS_DIR; }};")
    for p, n in files:
        w(f"\t\t{oid('fileref:' + p)} /* {n} */ = {{isa = PBXFileReference; lastKnownFileType = {file_type(n)}; path = {q(n)}; sourceTree = \"<group>\"; }};")
    w(f"\t\t{package_fileref} /* {PACKAGE_PRODUCT} */ = {{isa = PBXFileReference; lastKnownFileType = wrapper; name = {PACKAGE_PRODUCT}; path = {PACKAGE_PRODUCT}; sourceTree = \"<group>\"; }};")
    w("/* End PBXFileReference section */")

    # PBXFrameworksBuildPhase
    w("")
    w("/* Begin PBXFrameworksBuildPhase section */")
    w(f"\t\t{frameworks_phase} /* Frameworks */ = {{")
    w("\t\t\tisa = PBXFrameworksBuildPhase;")
    w("\t\t\tbuildActionMask = 2147483647;")
    w("\t\t\tfiles = (")
    w(f"\t\t\t\t{pkg_buildfile} /* {PACKAGE_PRODUCT} in Frameworks */,")
    w("\t\t\t);")
    w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    w("\t\t};")
    w("/* End PBXFrameworksBuildPhase section */")

    # PBXGroup
    w("")
    w("/* Begin PBXGroup section */")

    def emit_group(g: Group, is_root_app: bool):
        w(f"\t\t{g.id} /* {g.name} */ = {{")
        w("\t\t\tisa = PBXGroup;")
        w("\t\t\tchildren = (")
        for c in g.children:
            if isinstance(c, Group):
                w(f"\t\t\t\t{c.id} /* {c.name} */,")
            else:
                w(f"\t\t\t\t{oid('fileref:' + c[1])} /* {c[2]} */,")
        w("\t\t\t);")
        w(f"\t\t\tpath = {q(g.name)};")
        w("\t\t\tsourceTree = \"<group>\";")
        w("\t\t};")
        for c in g.children:
            if isinstance(c, Group):
                emit_group(c, False)

    w(f"\t\t{main_group} = {{")
    w("\t\t\tisa = PBXGroup;")
    w("\t\t\tchildren = (")
    w(f"\t\t\t\t{app_group.id} /* App */,")
    w(f"\t\t\t\t{packages_group} /* Packages */,")
    w(f"\t\t\t\t{products_group} /* Products */,")
    w("\t\t\t);")
    w("\t\t\tsourceTree = \"<group>\";")
    w("\t\t};")
    emit_group(app_group, True)
    w(f"\t\t{packages_group} /* Packages */ = {{")
    w("\t\t\tisa = PBXGroup;")
    w("\t\t\tchildren = (")
    w(f"\t\t\t\t{package_fileref} /* {PACKAGE_PRODUCT} */,")
    w("\t\t\t);")
    w("\t\t\tpath = Packages;")
    w("\t\t\tsourceTree = \"<group>\";")
    w("\t\t};")
    w(f"\t\t{products_group} /* Products */ = {{")
    w("\t\t\tisa = PBXGroup;")
    w("\t\t\tchildren = (")
    w(f"\t\t\t\t{product_id} /* {PROJECT_NAME}.app */,")
    w("\t\t\t);")
    w("\t\t\tname = Products;")
    w("\t\t\tsourceTree = \"<group>\";")
    w("\t\t};")
    w("/* End PBXGroup section */")

    # PBXNativeTarget
    w("")
    w("/* Begin PBXNativeTarget section */")
    w(f"\t\t{target_id} /* {PROJECT_NAME} */ = {{")
    w("\t\t\tisa = PBXNativeTarget;")
    w(f"\t\t\tbuildConfigurationList = {target_cfg_list} /* Build configuration list for PBXNativeTarget \"{PROJECT_NAME}\" */;")
    w("\t\t\tbuildPhases = (")
    w(f"\t\t\t\t{sources_phase} /* Sources */,")
    w(f"\t\t\t\t{frameworks_phase} /* Frameworks */,")
    w(f"\t\t\t\t{resources_phase} /* Resources */,")
    w("\t\t\t);")
    w("\t\t\tbuildRules = (")
    w("\t\t\t);")
    w("\t\t\tdependencies = (")
    w("\t\t\t);")
    w(f"\t\t\tname = {PROJECT_NAME};")
    w("\t\t\tpackageProductDependencies = (")
    w(f"\t\t\t\t{product_dep} /* {PACKAGE_PRODUCT} */,")
    w("\t\t\t);")
    w(f"\t\t\tproductName = {PROJECT_NAME};")
    w(f"\t\t\tproductReference = {product_id} /* {PROJECT_NAME}.app */;")
    w("\t\t\tproductType = \"com.apple.product-type.application\";")
    w("\t\t};")
    w("/* End PBXNativeTarget section */")

    # PBXProject
    w("")
    w("/* Begin PBXProject section */")
    w(f"\t\t{project_id} /* Project object */ = {{")
    w("\t\t\tisa = PBXProject;")
    w("\t\t\tattributes = {")
    w("\t\t\t\tBuildIndependentTargetsInParallel = 1;")
    w("\t\t\t\tLastSwiftUpdateCheck = 1500;")
    w("\t\t\t\tLastUpgradeCheck = 1500;")
    w("\t\t\t\tTargetAttributes = {")
    w(f"\t\t\t\t\t{target_id} = {{")
    w("\t\t\t\t\t\tCreatedOnToolsVersion = 15.0;")
    w("\t\t\t\t\t};")
    w("\t\t\t\t};")
    w("\t\t\t};")
    w(f"\t\t\tbuildConfigurationList = {proj_cfg_list} /* Build configuration list for PBXProject \"{PROJECT_NAME}\" */;")
    w("\t\t\tcompatibilityVersion = \"Xcode 15.0\";")
    w("\t\t\tdevelopmentRegion = \"pt-BR\";")
    w("\t\t\thasScannedForEncodings = 0;")
    w("\t\t\tknownRegions = (")
    w("\t\t\t\ten,")
    w("\t\t\t\tBase,")
    w("\t\t\t\t\"pt-BR\",")
    w("\t\t\t);")
    w(f"\t\t\tmainGroup = {main_group};")
    w("\t\t\tpackageReferences = (")
    w(f"\t\t\t\t{local_pkg_ref} /* XCLocalSwiftPackageReference \"{PACKAGE_PATH}\" */,")
    w("\t\t\t);")
    w(f"\t\t\tproductRefGroup = {products_group} /* Products */;")
    w("\t\t\tprojectDirPath = \"\";")
    w("\t\t\tprojectRoot = \"\";")
    w("\t\t\ttargets = (")
    w(f"\t\t\t\t{target_id} /* {PROJECT_NAME} */,")
    w("\t\t\t);")
    w("\t\t};")
    w("/* End PBXProject section */")

    # PBXResourcesBuildPhase
    w("")
    w("/* Begin PBXResourcesBuildPhase section */")
    w(f"\t\t{resources_phase} /* Resources */ = {{")
    w("\t\t\tisa = PBXResourcesBuildPhase;")
    w("\t\t\tbuildActionMask = 2147483647;")
    w("\t\t\tfiles = (")
    for p, n in resources:
        w(f"\t\t\t\t{oid('buildfile:' + p)} /* {n} in Resources */,")
    w("\t\t\t);")
    w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    w("\t\t};")
    w("/* End PBXResourcesBuildPhase section */")

    # PBXSourcesBuildPhase
    w("")
    w("/* Begin PBXSourcesBuildPhase section */")
    w(f"\t\t{sources_phase} /* Sources */ = {{")
    w("\t\t\tisa = PBXSourcesBuildPhase;")
    w("\t\t\tbuildActionMask = 2147483647;")
    w("\t\t\tfiles = (")
    for p, n in sources:
        w(f"\t\t\t\t{oid('buildfile:' + p)} /* {n} in Sources */,")
    w("\t\t\t);")
    w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    w("\t\t};")
    w("/* End PBXSourcesBuildPhase section */")

    # XCBuildConfiguration
    common_project = {
        "ALWAYS_SEARCH_USER_PATHS": "NO",
        "ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS": "YES",
        "CLANG_ANALYZER_NONNULL": "YES",
        "CLANG_ENABLE_MODULES": "YES",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "CLANG_WARN_DOCUMENTATION_COMMENTS": "YES",
        "CLANG_WARN_UNGUARDED_AVAILABILITY": "YES_AGGRESSIVE",
        "COPY_PHASE_STRIP": "NO",
        "ENABLE_STRICT_OBJC_MSGSEND": "YES",
        "ENABLE_USER_SCRIPT_SANDBOXING": "YES",
        "GCC_C_LANGUAGE_STANDARD": "gnu17",
        "GCC_NO_COMMON_BLOCKS": "YES",
        "IPHONEOS_DEPLOYMENT_TARGET": "16.0",
        "LOCALIZATION_PREFERS_STRING_CATALOGS": "YES",
        "MTL_FAST_MATH": "YES",
        "SDKROOT": "iphoneos",
        "SWIFT_VERSION": "5.9",
    }
    debug_project = dict(common_project, **{
        "DEBUG_INFORMATION_FORMAT": "dwarf",
        "ENABLE_TESTABILITY": "YES",
        "GCC_OPTIMIZATION_LEVEL": "0",
        "GCC_PREPROCESSOR_DEFINITIONS": ("DEBUG=1", "$(inherited)"),
        "MTL_ENABLE_DEBUG_INFO": "INCLUDE_SOURCE",
        "ONLY_ACTIVE_ARCH": "YES",
        "SWIFT_ACTIVE_COMPILATION_CONDITIONS": ("DEBUG", "$(inherited)"),
        "SWIFT_OPTIMIZATION_LEVEL": "-Onone",
    })
    release_project = dict(common_project, **{
        "DEBUG_INFORMATION_FORMAT": "dwarf-with-dsym",
        "ENABLE_NS_ASSERTIONS": "NO",
        "MTL_ENABLE_DEBUG_INFO": "NO",
        "SWIFT_COMPILATION_MODE": "wholemodule",
        "SWIFT_OPTIMIZATION_LEVEL": "-O",
        "VALIDATE_PRODUCT": "YES",
    })
    target_settings = {
        "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
        "ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME": "AccentColor",
        "CODE_SIGN_STYLE": "Automatic",
        "CURRENT_PROJECT_VERSION": "1",
        "GENERATE_INFOPLIST_FILE": "NO",
        "INFOPLIST_FILE": "App/Info.plist",
        "LD_RUNPATH_SEARCH_PATHS": ("$(inherited)", "@executable_path/Frameworks"),
        "MARKETING_VERSION": "1.0",
        "PRODUCT_BUNDLE_IDENTIFIER": BUNDLE_ID,
        "PRODUCT_NAME": "$(TARGET_NAME)",
        "SUPPORTED_PLATFORMS": "iphoneos iphonesimulator",
        "SUPPORTS_MACCATALYST": "NO",
        "SWIFT_EMIT_LOC_STRINGS": "YES",
        "SWIFT_STRICT_CONCURRENCY": "minimal",
        "TARGETED_DEVICE_FAMILY": "1",
    }

    def emit_cfg(cid: str, name: str, settings: dict):
        w(f"\t\t{cid} /* {name} */ = {{")
        w("\t\t\tisa = XCBuildConfiguration;")
        w("\t\t\tbuildSettings = {")
        for k in sorted(settings):
            v = settings[k]
            if isinstance(v, tuple):
                w(f"\t\t\t\t{k} = (")
                for item in v:
                    w(f"\t\t\t\t\t{q(item)},")
                w("\t\t\t\t);")
            else:
                w(f"\t\t\t\t{k} = {q(str(v))};")
        w("\t\t\t};")
        w(f"\t\t\tname = {name};")
        w("\t\t};")

    w("")
    w("/* Begin XCBuildConfiguration section */")
    emit_cfg(pcfg["Debug"], "Debug", debug_project)
    emit_cfg(pcfg["Release"], "Release", release_project)
    emit_cfg(tcfg["Debug"], "Debug", target_settings)
    emit_cfg(tcfg["Release"], "Release", target_settings)
    w("/* End XCBuildConfiguration section */")

    # XCConfigurationList
    w("")
    w("/* Begin XCConfigurationList section */")
    for cid, ids, label in ((proj_cfg_list, pcfg, f'PBXProject "{PROJECT_NAME}"'),
                            (target_cfg_list, tcfg, f'PBXNativeTarget "{PROJECT_NAME}"')):
        w(f"\t\t{cid} /* Build configuration list for {label} */ = {{")
        w("\t\t\tisa = XCConfigurationList;")
        w("\t\t\tbuildConfigurations = (")
        w(f"\t\t\t\t{ids['Debug']} /* Debug */,")
        w(f"\t\t\t\t{ids['Release']} /* Release */,")
        w("\t\t\t);")
        w("\t\t\tdefaultConfigurationIsVisible = 0;")
        w("\t\t\tdefaultConfigurationName = Release;")
        w("\t\t};")
    w("/* End XCConfigurationList section */")

    # Pacote local
    w("")
    w("/* Begin XCLocalSwiftPackageReference section */")
    w(f"\t\t{local_pkg_ref} /* XCLocalSwiftPackageReference \"{PACKAGE_PATH}\" */ = {{")
    w("\t\t\tisa = XCLocalSwiftPackageReference;")
    w(f"\t\t\trelativePath = {PACKAGE_PATH};")
    w("\t\t};")
    w("/* End XCLocalSwiftPackageReference section */")
    w("")
    w("/* Begin XCSwiftPackageProductDependency section */")
    w(f"\t\t{product_dep} /* {PACKAGE_PRODUCT} */ = {{")
    w("\t\t\tisa = XCSwiftPackageProductDependency;")
    w(f"\t\t\tproductName = {PACKAGE_PRODUCT};")
    w("\t\t};")
    w("/* End XCSwiftPackageProductDependency section */")

    w("\t};")
    w(f"\trootObject = {project_id} /* Project object */;")
    w("}")

    proj_dir = os.path.join(ROOT, PROJECT_NAME + ".xcodeproj")
    os.makedirs(proj_dir, exist_ok=True)
    path = os.path.join(proj_dir, "project.pbxproj")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out) + "\n")
    # Esquema compartilhado (para o Xcode abrir com o alvo selecionado)
    schemes = os.path.join(proj_dir, "xcshareddata", "xcschemes")
    os.makedirs(schemes, exist_ok=True)
    with open(os.path.join(schemes, PROJECT_NAME + ".xcscheme"), "w", encoding="utf-8") as fh:
        fh.write(SCHEME.format(name=PROJECT_NAME, target=target_id))
    print(f"gerado {os.path.relpath(path)} ({len(sources)} fontes Swift, {len(resources)} recursos)")


SCHEME = """<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1500" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "{target}" BuildableName = "{name}.app" BlueprintName = "{name}" ReferencedContainer = "container:{name}.xcodeproj"/>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
      </Testables>
   </TestAction>
   <LaunchAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle = "0" useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO" debugDocumentVersioning = "YES" debugServiceExtension = "internal" allowLocationSimulation = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "{target}" BuildableName = "{name}.app" BlueprintName = "{name}" ReferencedContainer = "container:{name}.xcodeproj"/>
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration = "Release" shouldUseLaunchSchemeArgsEnv = "YES" savedToolIdentifier = "" useCustomWorkingDirectory = "NO" debugDocumentVersioning = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "{target}" BuildableName = "{name}.app" BlueprintName = "{name}" ReferencedContainer = "container:{name}.xcodeproj"/>
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction buildConfiguration = "Debug"/>
   <ArchiveAction buildConfiguration = "Release" revealArchiveInOrganizer = "YES"/>
</Scheme>
"""

if __name__ == "__main__":
    main()
