# ML Kit discovers its component registrars by class name from manifest metadata.
# mobile_scanner 7.2.0 keeps com.google.mlkit.* only, which misses subpackages.
# R8 full mode can then remove registrar constructors and barcode initialization
# fails with a null reference even after camera permission has been granted.
# Match the upstream fix: https://github.com/juliansteenbakker/mobile_scanner/pull/1726
-keep class com.google.mlkit.** { *; }
