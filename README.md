# Buildalon unity-uwp-builder

[![Discord](https://img.shields.io/discord/939721153688264824.svg?label=&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2)](https://discord.gg/VM9cWJ9rjH) [![marketplace](https://img.shields.io/static/v1?label=&labelColor=505050&message=Buildalon%20Actions&color=FF1E6F&logo=github-actions&logoColor=0076D6)](https://github.com/marketplace?query=buildalon) [![validate](https://github.com/buildalon/unity-uwp-builder/actions/workflows/validate.yml/badge.svg?branch=main)](https://github.com/buildalon/unity-uwp-builder/actions/workflows/validate.yml)

A GitHub Action to build Unity exported UWP projects.

> [!NOTE]
> The main goal of this action to to take what is provided from Unity and package it to be directly uploaded to the Microsoft Store.

## How to use

### workflow

```yaml
steps:
  # required for unity-uwp-builder action
  - uses: microsoft/setup-msbuild@v2

  - uses: buildalon/unity-uwp-builder@v2
    id: uwp-build
    with:
      # The directory that contains the exported visual studio project from Unity.
      project-path: '/path/to/your/build/output/directory/**/*.sln'
      platform: 'Any CPU' # or 'x86', 'x64', 'ARM', 'ARM64'
      package-type: 'upload' # or 'sideload'

  - name: print outputs
    shell: bash
    run: |
      echo "Bundles: ${{ steps.uwp-build.outputs.bundles }}"
      echo "Output Directory: ${{ steps.uwp-build.outputs.output-directory }}"
      ls -R "${{ steps.uwp-build.outputs.output-directory }}"
```

### inputs

| name | description | required |
| ---- | ----------- | -------- |
| `project-path` | The directory that contains the exported visual studio project from Unity. | true |
| `configuration` | The configuration to use when building the visual studio project. | Defaults to `Master`. |
| `platform` | The platform to use when building the visual studio project. Can be: `Any CPU`, `x86`, `x64`, `ARM`, or `ARM64`. | Defaults to `Any CPU`. |
| `package-type` | The type of package to generate. Can be: `sideload` or `upload`. | Defaults to `sideload`. |
| `certificate-path` | The path to the certificate to use when packaging the UWP project. | Required when `package-type` is `sideload`. Defaults to the Unity generated test certificate. |
| `certificate-password` | The password for the certificate. | Required when providing your own certificate. |
| `windows-sdk-version` | The Windows SDK version to use for building. If not specified, the latest available SDK version will be automatically detected and used. | Optional. Format: `10.0.xxxxx.x` (e.g., `10.0.22621.0`) |
| `additional-args` | Additional arguments to pass to the msbuild command. | Optional. |

### outputs

- `bundles`: The paths to the generated appx bundles in json array.
- `output-directory`: The path to the package output directory.
