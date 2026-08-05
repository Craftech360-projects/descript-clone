# The JNI bridge that boots Node inside the app process.
#
# libnode.so and its headers are NOT in git — run `npm run fetch-libnode` in
# desktop/android first (see third_party/fetch-libnode.mjs).

cmake_minimum_required(VERSION 3.22.1)
project(jumpcut-node-bridge)

# The runtime we link against, exactly where fetch-libnode.mjs installed it.
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
    IMPORTED_LOCATION ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

add_library(native-lib SHARED native-lib.cpp)

# nodejs-mobile release zips carry headers under include/node.
target_include_directories(native-lib PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/libnode/include/node)

find_library(log-lib log)
target_link_libraries(native-lib libnode ${log-lib})
