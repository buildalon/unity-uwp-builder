#!/bin/bash
JOBS_JSON=$(jq -c . <<'EOF'
{
  "os": ["windows-latest"],
  "build-target": ["WSAPlayer"],
  "unity-version": ["2021.x", "2022.x", "6000.x"],
  "uwp-arch": ["x64", "ARM64"],
  "uwp-subtarget": ["PC", "HoloLens"],
  "uwp-package-type": ["sideload", "upload"],
  "uwp-package-format": ["appx", "msix"],
  "certificate-type": ["default", "custom"],
  "exclude": [
    {"uwp-package-type": "upload", "certificate-type": "custom"}
  ],
  "strategy": {
    "fail-fast": false
  }
}
EOF
)
echo "jobs=${JOBS_JSON}" >> "$GITHUB_OUTPUT"