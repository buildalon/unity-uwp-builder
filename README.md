# Buildalon unity-uwp-builder

A GitHub Action to build Unity exported UWP projects.

> [!NOTE]
> The main goal of this action to to take what is provided from Unity and package it to be directly uploaded to the Microsoft Store.

## How to use

### workflow

```yaml
steps:
  # required for unity-uwp-builder action
  - uses: actions/setup-dotnet@v4
    with:
      dotnet-version: '8.x'
  - uses: microsoft/setup-msbuild@v2

  - uses: buildalon/unity-uwp-builder@v1
    id: uwp-build
    with:
      project-path: '/path/to/your/build/output/directory'
      package-type: 'upload'

  - name: print outputs
    shell: bash
    run: |
      echo "Executable: ${{ steps.uwp-build.outputs.executable }}"
      echo "Output Directory: ${{ steps.uwp-build.outputs.output-directory }}"
      ls -R "${{ steps.uwp-build.outputs.output-directory }}"
```

### inputs

| name | description | required |
| ---- | ----------- | -------- |
| `project-path` | The directory that contains the exported visual studio project from Unity. | true |
| `configuration` | The configuration to use when building the visual studio project. | Defaults to `Master`. |
| `architecture` | The architecture to use when building the visual studio project. Can be: `x86`, `x64`, `ARM`, or `ARM64`. | Defaults to `ARM64`. |
| `package-type` | The type of package to generate. Can be: `sideload` or `upload`. | Defaults to `sideload`. |

### outputs

- `executable`: The path to the generated appx executable.
- `export-path`: The path to the export directory.
