from PIL import Image
import random
from os.path import join


def board_gen(*args, **kwargs):
    mode = "RGB"
    if "size" not in kwargs: size = input("Board size?\n")
    else: size = kwargs["size"]

    r = lambda :random.randint(0,255)
    if "colour1" not in kwargs: colour1 = (r(),r(),r())
    else: colour1 = kwargs["colour1"]

    if "colour2" not in kwargs: colour2 = opposite_colour(colour1)
    else: colour2 = kwargs["colour2"]

    board = Image.new(mode, (size,size))
    pixels = board.load()

    for i in range(0,size):
        x = i//(size/8)
        for j in range(0,size):
            y = j//(size/8)
            if (x+y)%2 == 0: pixels[i,j] = colour1
            else: pixels[i,j] = colour2
    
    board.save(join("assets","board.png"))


def opposite_colour(colour):
    r,g,b = colour
    return (255-r,255-g,255-b)

if __name__ == "__main__":
    board_gen(size=1024, colour1=(255,50,50))
    

