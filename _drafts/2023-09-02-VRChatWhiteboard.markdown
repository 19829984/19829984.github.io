---
layout: post
title:  "[Unity/VRChat] Creating a synced whiteboard in VRChat"
date:   2023-09-02 08:50:00 -0500
categories: Tech_Art
---

<p align="center">
    <img src="/assets/vr_whiteboard/demo.gif">
    <h5 align="center"><i> Demo of the whiteboard working between two networked players</i></h5>
</p>

## Table of Contents
- [Table of Contents](#table-of-contents)
- [Preface](#preface)
  - [How VRChat Players Usually Draw](#how-vrchat-players-usually-draw)
- [Requirements](#requirements)
- [SDF (Signed Distance Field)](#sdf-signed-distance-field)
  - [Limitations of SDFs](#limitations-of-sdfs)
- [Network Sync and Serialization](#network-sync-and-serialization)
  - [Polyline](#polyline)
- [Whiteboard Rendering Pipeline](#whiteboard-rendering-pipeline)
  - [1. Rendering Polylines](#1-rendering-polylines)
  - [2. Blit to Whiteboard Render Texture](#2-blit-to-whiteboard-render-texture)
  - [3. Rendering The Whiteboard SDF](#3-rendering-the-whiteboard-sdf)


## Preface
I was replicating a room from my college for use in VRChat, and it has some whiteboards. Naturally, we'd want to be able to draw on them in VRChat. However, this room has 8 sliding whiteboards and 4 static whiteboards, making a total of 12 whiteboards. This presented some technical challenges that took me a while to figure out, so I'd like to document my implementation here.

### How VRChat Players Usually Draw
VRChat provides sample prefabs that includes a pen for players to draw in 3D space. This is achieved by drawing ribbons along the points the pen samples in 3D space. However, this is not a good fit for whiteboards primarily because the number of ribbons must be limited, since they are their own GameObjects and can easily clutter the scene and reduce fps. We don't want people's pen strokes to start disappearing from the whiteboards as they put down more marks. Further, to replicate the feel of drawing on a whiteboard, we want strokes to be erasable and merge together when overlapped. Therefore, we must go with a texture solution. 

<p align="center">
    <img src="/assets/vr_whiteboard/3d_pen_example.png">
    <h5 align="center"><i> Ribbons being drawn in 3D space</i></h5>
</p>

## Requirements
These whiteboards must:
-   Have high image fidelity(smooth strokes)
-   Support colors
-   Erasable
-   Share one texture to save resources
-   Sync across the network

## SDF (Signed Distance Field)
*For more info about SDFs, read about them [**here**](https://iquilezles.org/articles/raymarchingdf/):*

The first and fourth requirement seems to contradict each other. Since the whiteboards will be viewed from up close and far away, to preserve stroke quality we'd need to allocate a large amount of pixels per whiteboard. However, to share that texture across 12 different whiteboards means that it must be an extremely large texture, which is simply unfeasible; especially for a VR application. 

Taking inspiration from Valve's [**excellent paper**](https://cdn.akamai.steamstatic.com/apps/valve/2007/SIGGRAPH2007_AlphaTestedMagnification.pdf) on rendering high quality glyphs with SDFs, the solution here is to use ***Signed Distance Fields(SDFs)*** as our texture. As seen from Valve's **Figure 1** example, they can render high quality images with small textures using only 8bit color depth. With this technique, we can combine the SDF textures for every whiteboard onto a single smaller texture that won't eat up all of our precious VRAM. 

### Limitations of SDFs
If we use SDFs, this means that we are limited on how many colors we can display. SDFs work of off single channel data, meaning that the source texture no longer represents color in RGBA, but instead represents 4 different SDFs, barring us from representing all colors. I think this tradeoff is well worth it, given the amount of resources we save with the SDF technique, as well as the high definition images we get out of it. 

## Network Sync and Serialization
To make the whiteboard work properly in multiplayer is rather tricky. We cannot directly serialize and deserialize textures over network in VRChat, since our bandwidth is **extremely limited**.

From [VRChat documentation](https://creators.vrchat.com/worlds/udon/networking/network-details/):

>Continuous sync is limited to roughly **200 bytes** per serialization.
>
>Manual sync is limited to roughly **49 Kilobytes** per serialization.
>
>Each manually-synced object is rate limited as a factor of the data size. The more it sends, the more its send rate is limited. You can call RequestSerialization as many times as you want, but it will wait until enough time has passed before calling OnPreSerialization, sending the data, and calling OnPostSerialization with the result.
>
>A single synced string can have roughly 126 characters in Continuous sync mode.
>
>You can send out about **11kb per second**.

At first, the pen would directly draw onto the client's render textures every frame while it's in contact. I tried to simply sync the transforms of a marker as often as I can, hoping that each client's result would be close enough, but that wasn't the case at all. 
<p align="center">
    <img src="/assets/vr_whiteboard/shit-network-1.png" width="50%"><img src="/assets/vr_whiteboard/shit-network-2.png" width="50%">
    <h5 align="center"><i>Two clients in the same world having wildly different results</i></h5>
</p>

### Polyline
So instead, at the suggestion of my friend [HeadMerchant](https://github.com/HeadMerchant), I changed the implementation to record polylines by sampling the pen's position, then drawing each polyline onto the whiteboard when it reaches a certain length or stops. 

Before a new polyline is drawn, we record the current one and serialize its data over the network. We use `Vector4[]` to store our polyline (`xyz` for position, `w` for color), so the amount of data we send over the network is negligible with short polylines. A `Vector4` has 4 `floats`, each `float` is 4 `bytes`, therefore with each polyline we send `polylineLength * 16` bytes of data. 

Since we're manually syncing, we are well below our 49 `kilobyte` per serialization bandwidth as long as we don't make each polyline too long. Theoretically, we can have `49*1024/16=3136` points per polyline before we each the manual sync limit. 

## Whiteboard Rendering Pipeline
With the rendering technique and our data structure established, now we can define a rather simple rendering pipeline:
1. [Draw a polyline stroke onto a render texture as a SDF](#1-rendering-polylines)
2. [Blit the render texture to one of the 4 channels in the whiteboard render texture, or subtract from all channels if erasing.](#2-blit-to-whiteboard-render-texture)
3. [Render the SDF texture with a custom shader on a whiteboard object](#3-rendering-the-whiteboard-sdf)

While my friend HeadMerchant suggested using Custom Render Textures' double buffering feature to combine both the stroke render texture and the whiteboard render texture into a single asset, unfortunately due to limitations in UdonSharp's API, Custom Render Textures are unavailable to us; nor were command buffers. Therefore, we must manually create both render textures assets and call `VRCGraphics.Blit()` manually to render them. 

For a prototype, I decided to only implement 8 of the 12 whiteboards using two `1086x1020` textures. I chose this resolution because each tile would be `543x255` with an aspect ratio of `2.413`, which matches the aspect ratio of my whiteboard model. This is important so that our texture is not stretched or squashed when it's used on the whiteboard asset. 

The stroke render texture is configured to only contain a single 8-bit unsigned channel without filtering, while the whiteboard texture is configured to contain 4 8-bit unsigned channels with bilinear filtering.

### 1. Rendering Polylines
To render polylines into marker strokes, we'd need the SDF function of a polyline. There is no closed form function for a polyline SDF, so we must calculate a cylinder sdf for each two consecutive points then combine them to generate our polyline SDF. From Inigo's list of SDF functions, the function for a capsule/line between two points in 3D space is:
```glsl
float sdCapsule( vec3 p, vec3 a, vec3 b, float r )
{
    vec3 pa = p - a, ba = b - a;
    float h = clamp( dot(pa,ba)/dot(ba,ba), 0.0, 1.0 );
    return length( pa - ba*h ) - r;
}
```
However, we must modify this to account for our aspect ratio. I've also changed it such that it returns the mask of a line without negative values
```glsl
float sdCapsule(float2 p, float2 a, float2 b, float r)
{
    float2 pa = p - a, ba = b - a;
    pa.x *= _AspectRatio;
    ba.x *= _AspectRatio;
    float h = clamp( dot(pa,ba)/dot(ba,ba), 0.0, 1.0 );
    return  max((-length( pa - ba*h ) + r)/r, 0);
}
```
For the prototype, I've limited each polyline to have a max of `20` points. In shaderlab, we can only statically define the size of arrays, so we will allocate an array of 20 `float4` to pass our `Vector4[]` into. Then, we'd also need to pass in the actual size of our polyline, since it could terminate before filling up all 20 points. Finally, we pass in the aspect ratio, as well as a scale and offset to sample the correct whiteboard tile's uv.
```glsl
float4 _Polyline_Pos[20];
float _Polyline_Len;
float _AspectRatio;
float4 _ScaleOffset;
```
Then, we write a fragment shader to render our stroke with.
```
fixed4 frag (v2f i) : SV_Target
{
    // Draw Line
    float2 uv = (i.uv * _ScaleOffset.xy) - _ScaleOffset.zw;
    // Discard fragments outside of the 0-1 uv range
    if (any(uv > 1 || uv < 0)){
        discard;
    }
    // Calculate sdf
    float val = sdCapsule(uv, float2(_Polyline_Pos[0].xy), float2(_Polyline_Pos[1].xy), _Polyline_Pos[0].z);
    for (int index = 1; index < _Polyline_Len; index++){
        float new_val = sdCapsule(uv, float2(_Polyline_Pos[index-1].xy), float2(_Polyline_Pos[index].xy), _Polyline_Pos[index-1].z);
        val = max(val, new_val);
    }
    fixed4 col = 0;
    col.rgb = val;

    col.a = 1;
    return col;
}
```
Finally, we render it with some UdonSharp calls
```csharp
// _AspectRatio and is set during initialization of the script 
whiteboardBlitMaterial.SetVectorArray("_Polyline_Pos", last_polyline);
whiteboardBlitMaterial.SetFloat("_Polyline_Len", last_polyline_index);
whiteboardBlitMaterial.SetVector("_ScaleOffset", scaleOffset);
VRCGraphics.Blit(markerDrawRT, markerDrawRT, whiteboardBlitMaterial, whiteboardBlitMaterial.FindPass("Draw"));
```

For organizational purposes, I will place this shader in a pass called `Draw` in a shader named `CustomWhiteboardBlit.shader`

\* Note that here we're not using the fourth element of our `float4` array. That's the color channel of the stroke, which will be used later in the whiteboard shader. However, we still pass in the `float4` array directly to avoid rebuilding a new `float3` array just to save a couple bytes of memory. 

<p align="center">
    <img src="/assets/vr_whiteboard/marker_rt_example.png">
    <h5 align="center"><i> Strokes being rendered onto each whiteboard tile</i></h5>
</p>

### 2. Blit to Whiteboard Render Texture
Now we must write two more shaders to add our strokes to the whiteboard texture's appropriate channel, or subtract from the whiteboard texture.

For a draw operation, we prepare a pass called `Add` configured to perform a max operation between the stroke texture and the whiteboard. Then in the fragment shader, we adjust for tiling with `_ScaleOffset`, then discard fragments outside of the 0-1 uv range, and finally multiply our texture sample with 
```glsl
Pass
{
    Name "Add"

    Blend One One
    BlendOp Max

    CGPROGRAM
...
    sampler2D _MainTex;
    float4 _MainTex_ST;
    fixed4 _Channel;
    float4 _ScaleOffset;
...
    fixed4 frag (v2f i) : SV_Target
    {
        float2 uv = (i.uv * _ScaleOffset.xy) - _ScaleOffset.zw;
        // Discard fragments outside of the 0-1 uv range
        if (any(uv > 1 || uv < 0)){
            discard;
        }
        // sample the texture with original uv because both
        // are already in grid format
        float val = tex2D(_MainTex, i.uv).r;
        // apply fog
        UNITY_APPLY_FOG(i.fogCoord, col);
        return val * _Channel;
    }
    ENDCG
}
```

Then, for erasing, we write a similar shader but with `RevSub` operation, which subtracts the source texture from the destination (subtracts our stroke from the whiteboard). We don't need a a `_Chanel` parameter because a eraser would erase all colors.
```glsl
Pass
{
    Name "Sub"

    Blend One One
    BlendOp RevSub

    CGPROGRAM
...
    sampler2D _MainTex;
    float4 _MainTex_ST;
    float4 _ScaleOffset;
...
    fixed4 frag (v2f i) : SV_Target
    {
        float2 uv = (i.uv * _ScaleOffset.xy) - _ScaleOffset.zw;
        // Discard fragments outside of the 0-1 uv range
        if (any(uv > 1 || uv < 0)){
            discard;
        }
        // sample the texture with original uv because both
        // are already in grid format
        fixed4 col = tex2D(_MainTex, i.uv).r;
        // apply fog
        UNITY_APPLY_FOG(i.fogCoord, col);
        return col;
    }
    ENDCG
}
```

I've placed these two shaders with the `Draw` pass inside `CustomWhiteboardBlit.shader`.

Then in UdonSharp, we render to the whiteboard with the following lines of code:
```csharp
whiteboardBlitMaterial.SetColor("_Channel", ConvertMarkerChannel((int)last_polyline[0][3]));
if (current_polyline_is_erase)
{
    VRCGraphics.Blit(markerDrawRT, whiteboardRT, whiteboardBlitMaterial, whiteboardBlitMaterial.FindPass("Sub"));
}
else
{
    VRCGraphics.Blit(markerDrawRT, whiteboardRT, whiteboardBlitMaterial, whiteboardBlitMaterial.FindPass("Add"));
}
```
### 3. Rendering The Whiteboard SDF
Finally, to render our SDF into a whiteboard, we write a Unity surface shader as follows:
```glsl
...
half _Glossiness;
half _Metallic;
fixed4 _Color1;
fixed4 _Color2;
fixed4 _Color3;
float _MarkerThreshold;
float4 _ScaleOffset;
float _Smoothness;
...
void surf (Input IN, inout SurfaceOutputStandard o)
{
    _Smoothness = min(_Smoothness, _MarkerThreshold);
    // Albedo comes from a texture tinted by color
    float2 uv = (IN.uv_MainTex + _ScaleOffset.zw) / _ScaleOffset.xy;
    fixed4 texSample = tex2D(_MainTex, uv);
    texSample -= _MarkerThreshold;
    // Anti-alias method with smoothstep mentioned by Valve in the same paper
    texSample = smoothstep(-_Smoothness, _Smoothness, texSample);

    fixed4 c1 = (texSample.r) * _Color1;
    fixed4 c2 = (texSample.g) * _Color2;
    fixed4 c3 = (texSample.b) * _Color3;
    float c4 = (texSample.a);
    fixed4 c = c1 + c2 + c3;
    float3 out_col = lerp(1, c.rgb, c.a) - c4;
    
    // Add smooth step to make the edges of the marker more smooth
    o.Albedo = out_col;
    // Metallic and smoothness come from slider variables
    o.Metallic = _Metallic;
    o.Smoothness = _Glossiness;
    o.Alpha = 1;
}
```
