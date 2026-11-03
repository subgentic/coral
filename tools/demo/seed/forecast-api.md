# Skyline: forecast API contract

`GET /forecast?city=<name>` returns five days.

## Fields
- `high_c`, `low_c`: the day's temperatures in degrees Celsius.
- `feels_like_c`: the wind-chill figure when it is cold and windy.

## Question
Return only Celsius, or Fahrenheit as well?
