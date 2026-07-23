# ChronoSync ProGuard Rules

# Keep ExoPlayer classes
-keep class androidx.media3.** { *; }
-keep class com.google.android.exoplayer2.** { *; }

# Keep Tesseract4Android
-keep class cz.adaptech.tesseract4android.** { *; }

# Keep model classes for serialization
-keep class com.chronosync.models.** { *; }

# General Android rules
-keepattributes *Annotation*
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
