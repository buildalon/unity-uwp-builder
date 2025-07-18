#!/bin/bash
# take the .github\workflows\build-options.json file and parse it.
BUILD_OPTIONS_FILE=".github/workflows/build-options.json"

if [[ ! -f "$BUILD_OPTIONS_FILE" ]]; then
    echo "Build options file not found: $BUILD_OPTIONS_FILE"
    exit 1
fi

BUILD_OPTIONS_JSON=$(jq -r '.' "$BUILD_OPTIONS_FILE")

# initialize an array to hold all jobs
INCLUDED_JOBS=()
EXCLUDED_JOBS=()

# using the BUILD_OPTIONS_JSON, create jobs for each combination
for UNITY_VERSION in $(echo "$BUILD_OPTIONS_JSON" | jq -r '."unity-version"[]'); do
    for UWP_ARCH in $(echo "$BUILD_OPTIONS_JSON" | jq -r '."uwp-arch"[]'); do
        for UWP_SUBTARGET in $(echo "$BUILD_OPTIONS_JSON" | jq -r '."uwp-subtarget"[]'); do
            for UWP_PACKAGE_TYPE in $(echo "$BUILD_OPTIONS_JSON" | jq -r '."uwp-package-type"[]'); do
                for UWP_PACKAGE_FORMAT in $(echo "$BUILD_OPTIONS_JSON" | jq -r '."uwp-package-format"[]'); do
                    for CERTIFICATE_TYPE in $(echo "$BUILD_OPTIONS_JSON" | jq -r '."certificate-type"[]'); do
                        # create a job object
                        JOB=$(jq -n \
                            --arg unity_version "$UNITY_VERSION" \
                            --arg uwp_arch "$UWP_ARCH" \
                            --arg uwp_subtarget "$UWP_SUBTARGET" \
                            --arg uwp_package_type "$UWP_PACKAGE_TYPE" \
                            --arg uwp_package_format "$UWP_PACKAGE_FORMAT" \
                            --arg certificate_type "$CERTIFICATE_TYPE" \
                            '{
                                "name": "($unity_version) $uwp_arch $uwp_subtarget $uwp_package_type $uwp_package_format $certificate_type",
                                "os": "windows-latest",
                                "build-target": "WSAPlayer",
                                "unity-version": $unity_version,
                                "uwp-arch": $uwp_arch,
                                "uwp-subtarget": $uwp_subtarget,
                                "uwp-package-type": $uwp_package_type,
                                "uwp-package-format": $uwp_package_format,
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
                            EXCLUDED_JOBS+=("$JOB")
                        else
                            INCLUDED_JOBS+=("$JOB")
                        fi
                    done
                done
            done
        done
    done
done

JOBS_JSON="{\"include\": [$(IFS=,; echo "${INCLUDED_JOBS[*]}")], \"exclude\": [$(IFS=,; echo "${EXCLUDED_JOBS[*]}")]}"
# show json debug
echo "Generated jobs JSON:"
echo "$JOBS_JSON"
echo "jobs=${JOBS_JSON}" >> "$GITHUB_OUTPUT"