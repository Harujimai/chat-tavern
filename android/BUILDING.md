# Building the Android client

Requirements:

- JDK 17
- Android SDK Platform 34 and Build Tools 34.0.0
- Gradle 8.7, or Android Studio with a compatible Gradle JDK

Debug build:

```bash
gradle assembleDebug
```

Release signing is intentionally not checked in. Configure your own keystore locally; never commit the keystore or its passwords.
