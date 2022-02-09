#!/bin/bash -x
# A script to invoke a health monitor API and send a notification if the API returns a non-200 status code.
# example invocation
#./health-notifier.bash "Production-Environment" "Database" "<https://api-endpoint>" "<https://slack-hook>"
env=$1
test_name=$2
endpoint=$3
slack_hook=$4
response=$(curl --write-out '%{http_code}' --silent --head --output /dev/null "$endpoint")

if (($response != 200)); then
  payload="{\"text\": \"[$env] $test_name is down! Got response code: $response <!everyone>\"}"
  curl -d "$payload" -H "Content-Type: application/json" -X POST "$slack_hook"
fi
