# Buildalon unity-uwp-builder

[![Discord](https://img.shields.io/discord/939721153688264824.svg?label=&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2)](https://discord.gg/VM9cWJ9rjH) [![marketplace](https://img.shields.io/static/v1?label=&labelColor=505050&message=Buildalon%20Actions&color=FF1E6F&logo=github-actions&logoColor=0076D6)](https://github.com/marketplace?query=buildalon) [![validate](https://github.com/buildalon/unity-uwp-builder/actions/workflows/validate.yml/badge.svg?branch=main)](https://github.com/buildalon/unity-uwp-builder/actions/workflows/validate.yml)

A GitHub Action to build Unity exported UWP projects.

> [!NOTE]
> The main goal of this action is to take what is provided from Unity and package it to be directly uploaded to the Microsoft Store.

## How to use

The action runs on Windows runners only, and needs `msbuild` on the `PATH`.

### Workflow

```yaml
jobs:
  build:
    runs-on: windows-latest
    steps:
      # export the WSAPlayer build from Unity first, for example with unity-action
      - uses: buildalon/unity-action@v4
        with:
          build-target: WSAPlayer
          log-name: WSAPlayer-Build
          args: -quit -batchmode -nographics -executeMethod Buildalon.Editor.BuildPipeline.UnityPlayerBuildTools.StartCommandLineBuild -arch ARM64

      # required for unity-uwp-builder action
      - uses: microsoft/setup-msbuild@v3

      # builds visual studio project for UWP and packages it for store upload
      - uses: buildalon/unity-uwp-builder@v2
        id: uwp-build
        with:
          project-path: path/to/your/build/output/directory
          platform: ARM64
          package-type: upload
          # store-association-path: path/to/Package.StoreAssociation.xml
          # certificate-path: path/to/your/certificate.pfx
          # certificate-password: ${{ secrets.UWP_CERTIFICATE_PASSWORD }}
          # windows-sdk-version: 10.0.26100.0

      - name: print outputs
        shell: bash
        env:
          EXECUTABLE: ${{ steps.uwp-build.outputs.executable }}
          BUNDLES: ${{ steps.uwp-build.outputs.bundles }}
          OUTPUT_DIRECTORY: ${{ steps.uwp-build.outputs.output-directory }}
        run: |
          echo "Executable: ${EXECUTABLE}"
          echo "Bundles: ${BUNDLES}"
          ls -R "${OUTPUT_DIRECTORY}"
```

### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `project-path` | The directory that contains the exported visual studio project from Unity, or the path to its `.sln` file. The first `.sln` found under the directory is built. | true | |
| `configuration` | The configuration to use when building the visual studio project. Can be `Master`, `Release`, or `Debug`. | false | `Master` |
| `platform` | The platform to use when building the visual studio project. Can be: `x86`, `x64`, `ARM`, or `ARM64`. | false | The platforms defined in the visual studio project |
| `package-type` | The type of package to generate. Can be: `sideload` or `upload`. | false | `sideload` |
| `certificate-path` | The path to the `.pfx` certificate, or a directory to search for one, used to sign the package. | false | The Unity generated test certificate in the exported project |
| `certificate-password` | The password for the certificate. | When your certificate is password protected. | |
| `windows-sdk-version` | The Windows SDK version to build with, such as `10.0.22621.0`. Falls back to the latest installed SDK, with a warning, when the runner doesn't have it. | false | The latest Windows SDK on the runner |
| `additional-args` | Additional arguments to pass to the msbuild command, separated by spaces. | false | |
| `store-association-path` | The path to the `Package.StoreAssociation.xml` file that associates the package with your Microsoft Store app. Use with `package-type: upload`. | false | |

The deprecated `architecture` input still works; use `platform` instead.

When `store-association-path` is set, the action copies the file next to the app project, matches the `Package.appxmanifest` identity and display name to it, and bundles the architectures it lists.

With Windows SDK `10.0.26100.0` or newer, the action removes the `WindowsMobile` extension SDK reference from the exported projects, since those SDKs no longer ship it. When the exported project asks for a platform toolset the runner's Visual Studio doesn't have, the newest installed UWP toolset is used instead.

### Outputs

| Output | Description |
|--------|-------------|
| `executable` | The path to the main generated package: the `.appxupload`/`.msixupload` for `upload`, or the bundle or package for `sideload`. |
| `bundles` | A JSON array of the paths to every generated package and bundle. |
| `output-directory` | The path to the `AppPackages` output directory. |

The action runs on Node 24, so self-hosted runners need [actions/runner](https://github.com/actions/runner) v2.327.1 or newer.
