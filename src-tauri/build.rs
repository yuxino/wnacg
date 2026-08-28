fn main() {
    // Tauri embeds the ICNS in app bundles and uses the desktop PNG/ICO set
    // on other targets. Rebuild when an icon-only change lands.
    for icon in [
        "icons/kiri/32x32.png",
        "icons/kiri/128x128.png",
        "icons/kiri/128x128@2x.png",
        "icons/kiri/icon.icns",
        "icons/kiri/icon.ico",
        "icons/kiri/icon-manifest.json",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }

    tauri_build::build()
}
