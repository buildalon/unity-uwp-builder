#!/bin/bash
# take the .github\workflows\build-options.json file and parse it.
BUILD_OPTIONS_FILE=".github/workflows/build-options.json"

if [[ ! -f "$BUILD_OPTIONS_FILE" ]]; then
    echo "Build options file not found: $BUILD_OPTIONS_FILE"
    exit 1
fi

BUILD_OPTIONS_JSON=$(jq -r '.' "$BUILD_OPTIONS_FILE")

# initialize associative arrays to hold jobs grouped by unity version
declare -A UNITY_VERSION_JOBS
declare -A UNITY_VERSION_EXCLUDED_JOBS

# using the BUILD_OPTIONS_JSON, create jobs for each combination

# Properly handle unity-version values with spaces/parentheses
while IFS= read -r UNITY_VERSION; do
    # Initialize arrays for this unity version if not already done
    if [[ -z "${UNITY_VERSION_JOBS[$UNITY_VERSION]}" ]]; then
        UNITY_VERSION_JOBS[$UNITY_VERSION]=""
        UNITY_VERSION_EXCLUDED_JOBS[$UNITY_VERSION]=""
    fi

    while IFS= read -r UWP_ARCH; do
        while IFS= read -r UWP_SUBTARGET; do
            while IFS= read -r UWP_PACKAGE_TYPE; do
                    while IFS= read -r CERTIFICATE_TYPE; do
                        JOB=$(jq -c -n \
                            --arg name "$UWP_ARCH $UWP_SUBTARGET $UWP_PACKAGE_TYPE $CERTIFICATE_TYPE" \
                            --arg unity_version "${UNITY_VERSION}" \
                            --arg uwp_arch "${UWP_ARCH}" \
                            --arg uwp_subtarget "${UWP_SUBTARGET}" \
                            --arg uwp_package_type "${UWP_PACKAGE_TYPE}" \
                            --arg certificate_type "${CERTIFICATE_TYPE}" \
                            '{
                                "name": $name,
                                "os": "windows-latest",
                                "build-target": "WSAPlayer",
                                "unity-version": $unity_version,
                                "uwp-arch": $uwp_arch,
                                "uwp-subtarget": $uwp_subtarget,
                                "uwp-package-type": $uwp_package_type,
                                "certificate-type": $certificate_type
                            }')
                        # check if the job matches any exclusion rule
                        EXCLUDE_MATCH=false
                        for EXCLUDE_RULE in $(echo "$BUILD_OPTIONS_JSON" | jq -c '.exclude[]'); do
                            MATCH=true
                            for KEY in $(echo "$EXCLUDE_RULE" | jq -r 'keys[]'); do
                                RULE_VALUE=$(echo "$EXCLUDE_RULE" | jq -r --arg key "$KEY" '.[$key]')
                                JOB_VALUE=$(echo "$JOB" | jq -r --arg key "$KEY" '.[$key]')
                                if [[ "$RULE_VALUE" != "$JOB_VALUE" ]]; then
                                    MATCH=false
                                    break
                                fi
                            done
                            if [[ "$MATCH" == true ]]; then
                                EXCLUDE_MATCH=true
                                break
                            fi
                        done
                        if [[ "$EXCLUDE_MATCH" == true ]]; then
                            if [[ -z "${UNITY_VERSION_EXCLUDED_JOBS[$UNITY_VERSION]}" ]]; then
                                UNITY_VERSION_EXCLUDED_JOBS[$UNITY_VERSION]="$JOB"
                            else
                                UNITY_VERSION_EXCLUDED_JOBS[$UNITY_VERSION]="${UNITY_VERSION_EXCLUDED_JOBS[$UNITY_VERSION]}
$JOB"
                            fi
                        else
                            if [[ -z "${UNITY_VERSION_JOBS[$UNITY_VERSION]}" ]]; then
                                UNITY_VERSION_JOBS[$UNITY_VERSION]="$JOB"
                            else
                                UNITY_VERSION_JOBS[$UNITY_VERSION]="${UNITY_VERSION_JOBS[$UNITY_VERSION]}
$JOB"
                            fi
                        fi
                    done < <(echo "$BUILD_OPTIONS_JSON" | jq -r '."certificate-type"[]')
                done < <(echo "$BUILD_OPTIONS_JSON" | jq -r '."uwp-package-type"[]')
            done < <(echo "$BUILD_OPTIONS_JSON" | jq -r '."uwp-subtarget"[]')
        done < <(echo "$BUILD_OPTIONS_JSON" | jq -r '."uwp-arch"[]')
    done < <(echo "$BUILD_OPTIONS_JSON" | jq -r '."unity-version"[]')

# Create grouped jobs structure
JOBS_ARRAY=()

for UNITY_VERSION in "${!UNITY_VERSION_JOBS[@]}"; do
    # Skip if this unity version has no included jobs
    if [[ -z "${UNITY_VERSION_JOBS[$UNITY_VERSION]}" ]]; then
        continue
    fi

    # Create job name
    JOB_NAME="Build ${UNITY_VERSION}"

    # Convert newline-separated job strings to JSON array
    UNITY_JOBS_ARRAY="[]"
    if [[ -n "${UNITY_VERSION_JOBS[$UNITY_VERSION]}" ]]; then
        UNITY_JOBS_ARRAY=$(echo "${UNITY_VERSION_JOBS[$UNITY_VERSION]}" | jq -s .)
    fi

    # Create matrix for this unity version
    UNITY_MATRIX=$(jq -c -n \
        --argjson include "$UNITY_JOBS_ARRAY" \
        '{
            include: $include
        }')

    # Create job object and add to array
    JOB_OBJECT=$(jq -c -n \
        --arg name "$JOB_NAME" \
        --argjson matrix "$UNITY_MATRIX" \
        '{
            "name": $name,
            "matrix": $matrix
        }')

    JOBS_ARRAY+=("$JOB_OBJECT")
done

# Create final JSON structure with jobs as the top-level object
JOBS_JSON=$(jq -c -n \
    --argjson jobs "$(printf '%s\n' "${JOBS_ARRAY[@]}" | jq -s .)" \
    '{
        "jobs": $jobs
    }')

echo "Generated jobs JSON:"
echo "$JOBS_JSON" | jq .
echo "jobs=${JOBS_JSON}" >> "$GITHUB_OUTPUT"