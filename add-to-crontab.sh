#!/bin/bash

# A script to add any command to crontab iff it dosen't already exist in the crontab.
# Majorly inspired from https://unix.stackexchange.com/questions/297374/add-something-to-crontab-programmatically-over-ssh
# Pass the cron, cmd to run and 4 optional parameters to the cmd 

cron=$1
cmd=$2
entry="$cron $cmd $3 $4 $5 $6"
printf "Adding entry:\n$entry\n\n"
escapedEntry=$(printf '%s\n' "$entry" | sed 's:[][\/.^$*]:\\&:g') #from: https://unix.stackexchange.com/a/129063/320236
printf "Maching for exisitng entry of the regex pattern:\n$escapedEntry\n\n"

if [[ $(crontab -l | egrep -v '^(#|$)' | grep -q "$escapedEntry"; echo $?) == 1 ]] # from: https://unix.stackexchange.com/a/297377/320236
then
    printf "Pattern doesn't exist; adding command to crontab:\n$cmd\n\n"
    (crontab -l ; printf "$entry\n\n") | crontab -
else
    printf "Pattern already present; no action taken\n\n"
fi
